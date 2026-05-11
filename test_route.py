from flask import Flask, request, jsonify

app = Flask(__name__)

@app.route("/api/payroll/payslips/<payslip_id>", methods=["GET"])
def get_payslip(payslip_id):
    return "ID"

@app.route("/api/payroll/payslips/approve", methods=["POST", "OPTIONS"])
def approve():
    return "APPROVE"

@app.route("/api/payroll/payslips/status", methods=["GET", "HEAD", "OPTIONS"])
def status():
    return "STATUS"

print(app.url_map)
with app.test_client() as c:
    print("GET status:", c.get("/api/payroll/payslips/status").data)
    print("POST approve:", c.post("/api/payroll/payslips/approve").data)
    print("GET id:", c.get("/api/payroll/payslips/some_id").data)

