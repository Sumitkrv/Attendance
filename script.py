import re

app_file = "backend/src/routes/payroll.py"
with open(app_file, "r") as f:
    orig_content = f.read()

# 1. Remove the unified endpoints that were added to the end of the file.
content = orig_content
for block in [
    r"@payroll_bp.route\(\"/api/payroll/payslips/approve\", methods=\[\"POST\", \"OPTIONS\"\]\).*?(?=\n@|# =|$)",
    r"@payroll_bp.route\(\"/api/payroll/payslips/status\", methods=\[\"GET\", \"HEAD\", \"OPTIONS\"\]\).*?(?=\n@|# =|$)",
    r"@payroll_bp.route\(\"/api/payroll/payslips/history\", methods=\[\"GET\", \"HEAD\", \"OPTIONS\"\]\).*?(?=\n@|# =|$)"
]:
    content = re.sub(block, "", content, flags=re.DOTALL)

# 2. Re-insert them ABOVE the wildcard /api/payroll/payslips/<payslip_id>

unified_routes = """
@payroll_bp.route("/api/payroll/payslips/status", methods=["GET", "HEAD", "OPTIONS"])
@admin_auth_required
def payroll_payslip_status_unified():
    print("METHOD:", request.method, "QUERY:", request.args, "BODY:", None, "PARAMS:", "status")
    db = _get_db()
    if db is None:
        return jsonify({"success": False, "message": "Database not available", "data": None}), 503
    employee_id = request.args.get("employee_id")
    if not employee_id:
        return jsonify({"success": False, "message": "employee_id is required", "data": None}), 400
    try:
        year = int(request.args.get("year", 0))
        month = int(request.args.get("month", 0))
    except (TypeError, ValueError):
        return jsonify({"success": False, "message": "year and month are required integers", "data": None}), 400
    
    payload, code = _payslip_admin_status_payload(db, employee_id, year, month)
    return jsonify({"success": True if code == 200 else False, "message": "", "data": payload}), code

@payroll_bp.route("/api/payroll/payslips/history", methods=["GET", "HEAD", "OPTIONS"])
@admin_auth_required
def payroll_payslip_history_unified():
    print("METHOD:", request.method, "QUERY:", request.args, "BODY:", None, "PARAMS:", "history")
    db = _get_db()
    if db is None:
        return jsonify({"success": False, "message": "Database not available", "data": None}), 503
    employee_id = request.args.get("employee_id")
    if not employee_id:
        return jsonify({"success": False, "message": "employee_id is required", "data": None}), 400
    try:
        from bson.errors import InvalidId
        from bson import ObjectId
        ObjectId(employee_id)
    except InvalidId:
        return jsonify({"success": False, "message": "Invalid employee ID", "data": None}), 400

    payload = _payslip_admin_history_payload(db, employee_id)
    return jsonify({"success": True, "message": "", "data": payload}), 200

@payroll_bp.route("/api/payroll/payslips/approve", methods=["POST", "PATCH", "OPTIONS"])
@admin_auth_required
def payroll_payslip_approve_unified():
    body = request.get_json(force=True, silent=True) or {}
    print("METHOD:", request.method, "QUERY:", request.args, "BODY:", body, "PARAMS:", "approve")
    db = _get_db()
    if db is None:
        return jsonify({"success": False, "message": "Database not available", "data": None}), 503
    
    employee_id = body.get("employee_id")
    if not employee_id:
        return jsonify({"success": False, "message": "employee_id is required", "data": None}), 400
    try:
        year = int(body.get("year", 0))
        month = int(body.get("month", 0))
    except (TypeError, ValueError):
        return jsonify({"success": False, "message": "year and month are required integers", "data": None}), 400
    
    try:
        from bson.errors import InvalidId
        from bson import ObjectId
        ObjectId(employee_id)
    except InvalidId:
         return jsonify({"success": False, "message": "Invalid employee id", "data": None}), 400

    res, code = _payslip_admin_approve(db, str(employee_id), year, month)
    res_data = res.get_json() if hasattr(res, 'get_json') else {}
    return jsonify({
        "success": True if code == 200 else False,
        "message": res_data.get("message", "Payslip approved. Employee can now download." if code == 200 else "Error"),
        "data": res_data
    }), code

"""

content = content.replace('@payroll_bp.route("/api/payroll/payslips/<payslip_id>", methods=["GET"])', unified_routes + '\n@payroll_bp.route("/api/payroll/payslips/<payslip_id>", methods=["GET"])')

# Ensure we aren't duplicating
if content.count('def payroll_payslip_status_unified') > 1:
    print("Duplication detected. Manual review needed.")
else:
    with open(app_file, "w") as f:
        f.write(content)
