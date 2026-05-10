"""Helpers for resolving employees and queries scoped to a company record (multi-company isolation)."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from bson import ObjectId


def _norm_company_label(value: Optional[str]) -> str:
    """Lowercase label with collapsed whitespace — matches sloppy legacy `company_name` text."""
    return " ".join(str(value or "").strip().lower().split())


def resolve_company_aliases(db, company_id: str) -> List[str]:
    """Return distinct display/id strings that identify employees belonging to this company."""
    cid = str(company_id or "").strip()
    if not cid:
        return []
    doc = db.companies.find_one({"id": cid})
    if doc:
        out: List[str] = []
        for key in ("id", "name", "companyCode"):
            v = str(doc.get(key) or "").strip()
            if v:
                out.append(v)
        return list(dict.fromkeys(out))
    return [cid]


def _is_default_primary_company(company_id: str) -> bool:
    """Company id PR is the seeded default; legacy rows often omitted company_name."""
    return str(company_id or "").strip().upper() == "PR"


def employees_match_query_for_company(db, company_id: str) -> Dict[str, Any]:
    """Mongo filter on `employees` so rows belong to the given company id."""
    cid = str(company_id or "").strip()
    if not cid:
        return {"_id": {"$in": []}}
    aliases = resolve_company_aliases(db, cid)
    if not aliases:
        return {"_id": {"$in": []}}
    or_clauses: List[Dict[str, Any]] = []
    for a in aliases:
        a = str(a or "").strip()
        if not a:
            continue
        esc = re.escape(a)
        id_pat = {"$regex": f"^\\s*{esc}\\s*$", "$options": "i"}
        or_clauses.append({"company_id": id_pat})
        parts = [re.escape(p) for p in a.split() if p.strip()]
        if parts:
            name_relaxed = "\\s+".join(parts)
            or_clauses.append({"company_name": {"$regex": f"^\\s*{name_relaxed}\\s*$", "$options": "i"}})
    # Legacy PR: orphan rows omitted both identifiers (don't pull other tenants' blank-name rows).
    if _is_default_primary_company(company_id):
        blank_name = {
            "$or": [
                {"company_name": {"$exists": False}},
                {"company_name": None},
                {"company_name": ""},
                {"company_name": {"$regex": r"^\s*$"}},
            ],
        }
        blank_cid = {
            "$or": [
                {"company_id": {"$exists": False}},
                {"company_id": None},
                {"company_id": ""},
                {"company_id": {"$regex": r"^\s*$"}},
            ],
        }
        or_clauses.append({"$and": [blank_name, blank_cid]})
    return {"$or": or_clauses} if or_clauses else {"_id": {"$in": []}}


def list_company_employee_object_ids(db, company_id: str) -> List[ObjectId]:
    q = employees_match_query_for_company(db, company_id)
    return [row["_id"] for row in db.employees.find(q, {"_id": 1})]


def list_company_employee_id_strings(db, company_id: str) -> List[str]:
    return [str(x) for x in list_company_employee_object_ids(db, company_id)]


def employee_doc_matches_company(
    db,
    company_id: str,
    company_name_on_employee: str,
    company_id_on_employee: Optional[str] = None,
) -> bool:
    cid = str(company_id or "").strip()
    if not cid:
        return False
    aliases = [a.strip() for a in resolve_company_aliases(db, cid) if str(a or "").strip()]
    if not aliases:
        return False

    alias_n = {_norm_company_label(a) for a in aliases if _norm_company_label(a)}

    if _norm_company_label(company_id_on_employee) in alias_n:
        return True
    if _norm_company_label(company_name_on_employee) in alias_n:
        return True

    if _is_default_primary_company(cid) and not _norm_company_label(company_name_on_employee) and not _norm_company_label(
        company_id_on_employee
    ):
        return True
    return False
