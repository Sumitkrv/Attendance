import os
import json
import shutil
import subprocess
from pathlib import Path
from datetime import datetime

from pymongo import MongoClient
from dotenv import load_dotenv


BASE_DIR = Path(__file__).resolve().parents[1]


def _load_environment():
    env_aliases = {
        "development": "dev",
        "dev": "dev",
        "staging": "staging",
        "production": "prod",
        "prod": "prod",
    }
    requested_env = str(os.getenv("APP_ENV") or os.getenv("FLASK_ENV") or "dev").strip().lower()
    app_env = env_aliases.get(requested_env, requested_env)
    explicit_env_file = str(os.getenv("ENV_FILE", "") or "").strip()

    candidates = []
    if explicit_env_file:
        p = Path(explicit_env_file)
        candidates.append(p if p.is_absolute() else BASE_DIR / p)
    else:
        candidates.append(BASE_DIR / f".env.{app_env}")
        candidates.append(BASE_DIR / ".env")

    for path in candidates:
        if path.exists():
            load_dotenv(dotenv_path=path, override=False)
            return str(path)

    load_dotenv(override=False)
    return None


def _run_version(cmd):
    path = shutil.which(cmd)
    if not path:
        return {"installed": False, "path": None, "version": None}
    try:
        proc = subprocess.run([cmd, "--version"], capture_output=True, text=True, timeout=8, check=False)
        text = (proc.stdout or proc.stderr or "").strip().splitlines()
        return {
            "installed": proc.returncode == 0,
            "path": path,
            "version": (text[0] if text else "unknown"),
        }
    except Exception as exc:
        return {"installed": False, "path": path, "version": str(exc)}


def main():
    loaded_env_file = _load_environment()
    mongo_uri = str(os.getenv("MONGODB_URI", "mongodb://localhost:27017")).strip()
    db_name = str(os.getenv("MONGODB_DB", "face_attendance")).strip() or "face_attendance"

    report = {
        "time": datetime.utcnow().isoformat() + "Z",
        "mongo_uri_masked": mongo_uri.split("@")[-1] if "@" in mongo_uri else mongo_uri,
        "db_name": db_name,
        "env_file": loaded_env_file,
        "checks": {},
        "ok": False,
        "failures": [],
    }

    # command checks
    dump_info = _run_version("mongodump")
    restore_info = _run_version("mongorestore")
    report["checks"]["mongodump"] = dump_info
    report["checks"]["mongorestore"] = restore_info

    if not dump_info.get("installed"):
        report["failures"].append("mongodump_not_installed")
    if not restore_info.get("installed"):
        report["failures"].append("mongorestore_not_installed")

    # db connectivity checks
    try:
        client = MongoClient(mongo_uri, serverSelectionTimeoutMS=3000)
        client.admin.command("ping")
        db = client[db_name]
        colls = db.list_collection_names()
        report["checks"]["mongo_ping"] = {"ok": True}
        report["checks"]["collections"] = {"ok": True, "count": len(colls), "names": sorted(colls)}
    except Exception as exc:
        report["checks"]["mongo_ping"] = {"ok": False, "error": str(exc)}
        report["failures"].append("mongo_ping_failed")

    report["ok"] = len(report["failures"]) == 0
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
