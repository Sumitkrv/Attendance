#!/usr/bin/env python3
"""
Simple mock Flask server to respond to frontend API calls
"""
from flask import Flask, jsonify, request
from flask_cors import CORS
from datetime import datetime, timedelta
import json

app = Flask(__name__)
CORS(app, origins=["*"])

# Mock data
COMPANIES = {
    "PR": {
        "id": "PR",
        "name": "PR Company",
        "status": "active"
    }
}

EMPLOYEES = {
    "emp1": {
        "id": "emp1",
        "name": "John Doe",
        "email": "john@example.com",
        "company_id": "PR",
        "status": "active"
    },
    "emp2": {
        "id": "emp2",
        "name": "Jane Smith",
        "email": "jane@example.com",
        "company_id": "PR",
        "status": "active"
    }
}

ATTENDANCE_DATA = []

# Initialize some mock attendance
for i in range(10):
    ATTENDANCE_DATA.append({
        "id": f"att_{i}",
        "employee_id": f"emp{(i % 2) + 1}",
        "date": (datetime.now() - timedelta(days=i)).isoformat(),
        "check_in": f"09:{30 + i:02d}:00",
        "check_out": f"17:{30 + i:02d}:00",
        "status": "present"
    })

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "message": "Mock server is running"}), 200

@app.route('/api/companies', methods=['GET'])
def get_companies():
    return jsonify({
        "success": True,
        "data": list(COMPANIES.values())
    }), 200

@app.route('/api/companies/<company_id>', methods=['GET'])
def get_company(company_id):
    if company_id in COMPANIES:
        return jsonify({
            "success": True,
            "data": COMPANIES[company_id]
        }), 200
    return jsonify({"success": False, "message": "Company not found"}), 404

@app.route('/api/departments', methods=['GET'])
def get_departments():
    return jsonify({
        "success": True,
        "data": [
            {"id": "dept1", "name": "Engineering"},
            {"id": "dept2", "name": "Sales"},
            {"id": "dept3", "name": "HR"}
        ]
    }), 200

@app.route('/api/roles', methods=['GET'])
def get_roles():
    return jsonify({
        "success": True,
        "data": [
            {"id": "role1", "name": "Admin"},
            {"id": "role2", "name": "Manager"},
            {"id": "role3", "name": "Employee"}
        ]
    }), 200

@app.route('/api/companies/<company_id>/employees', methods=['GET'])
def get_employees(company_id):
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 100, type=int)
    
    company_employees = [e for e in EMPLOYEES.values() if e['company_id'] == company_id]
    return jsonify({
        "success": True,
        "data": company_employees[(page-1)*per_page : page*per_page],
        "total": len(company_employees)
    }), 200

@app.route('/api/employees', methods=['GET'])
def get_all_employees():
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 100, type=int)
    company_id = request.args.get('company_id', '')
    
    if company_id:
        employees = [e for e in EMPLOYEES.values() if e['company_id'] == company_id]
    else:
        employees = list(EMPLOYEES.values())
    
    return jsonify({
        "success": True,
        "data": employees[(page-1)*per_page : page*per_page],
        "total": len(employees)
    }), 200

@app.route('/api/companies/<company_id>/attendance', methods=['GET'])
def get_attendance(company_id):
    date_str = request.args.get('date', datetime.now().strftime('%Y-%m-%d'))
    return jsonify({
        "success": True,
        "data": ATTENDANCE_DATA,
        "date": date_str
    }), 200

@app.route('/attendance', methods=['GET'])
def get_attendance_v2():
    date_str = request.args.get('date', datetime.now().strftime('%Y-%m-%d'))
    return jsonify({
        "success": True,
        "data": ATTENDANCE_DATA,
        "date": date_str
    }), 200

@app.route('/api/leave-analytics', methods=['GET'])
def get_leave_analytics():
    company_id = request.args.get('company_id', 'PR')
    return jsonify({
        "success": True,
        "data": {
            "total_leaves": 12,
            "used_leaves": 3,
            "remaining_leaves": 9
        }
    }), 200

@app.route('/api/warn-employee/counts', methods=['GET'])
def get_warn_counts():
    company_id = request.args.get('company_id', 'PR')
    return jsonify({
        "success": True,
        "data": {
            "total_warnings": 5,
            "active_warnings": 2
        }
    }), 200

@app.route('/api/alerts', methods=['GET'])
def get_alerts():
    date = request.args.get('date', datetime.now().strftime('%Y-%m-%d'))
    limit = request.args.get('limit', 20, type=int)
    company_id = request.args.get('company_id', 'PR')
    
    return jsonify({
        "success": True,
        "data": [
            {"id": "alert1", "message": "Employee late check-in", "severity": "warning"},
            {"id": "alert2", "message": "Unusual activity detected", "severity": "info"}
        ]
    }), 200

@app.route('/api/leave_requests', methods=['GET'])
def get_leave_requests():
    company_id = request.args.get('company_id', 'PR')
    return jsonify({
        "success": True,
        "data": [
            {"id": "leave1", "employee_id": "emp1", "type": "sick", "status": "pending"},
            {"id": "leave2", "employee_id": "emp2", "type": "vacation", "status": "approved"}
        ]
    }), 200

@app.route('/manual_requests', methods=['GET'])
def get_manual_requests():
    company_id = request.args.get('company_id', 'PR')
    return jsonify({
        "success": True,
        "data": [
            {"id": "req1", "employee_id": "emp1", "type": "attendance_correction", "status": "pending"}
        ]
    }), 200

@app.route('/tasks', methods=['GET'])
def get_tasks():
    company_id = request.args.get('company_id', 'PR')
    return jsonify({
        "success": True,
        "data": [
            {"id": "task1", "name": "Sync attendance", "status": "completed"},
            {"id": "task2", "name": "Process payroll", "status": "pending"}
        ]
    }), 200

@app.route('/camera_status', methods=['GET'])
def get_camera_status():
    return jsonify({
        "success": True,
        "data": {
            "status": "active",
            "cameras": [
                {"id": "cam1", "name": "Main Entrance", "status": "online"},
                {"id": "cam2", "name": "Back Entrance", "status": "online"}
            ]
        }
    }), 200

@app.route('/api/v1/login', methods=['POST'])
def login():
    data = request.get_json() or {}
    username = data.get('username', '')
    password = data.get('password', '')
    
    if username and password:
        return jsonify({
            "success": True,
            "token": "mock_token_" + username,
            "user": {
                "id": "user1",
                "username": username,
                "role": "admin"
            }
        }), 200
    
    return jsonify({
        "success": False,
        "message": "Invalid credentials"
    }), 401

@app.route('/api/v1/mark-attendance', methods=['POST'])
def mark_attendance():
    data = request.get_json() or {}
    return jsonify({
        "success": True,
        "message": "Attendance marked successfully",
        "data": {
            "id": "att_" + str(len(ATTENDANCE_DATA)),
            "timestamp": datetime.now().isoformat()
        }
    }), 200

@app.route('/api/v1/attendance-history/<user_id>', methods=['GET'])
def get_attendance_history(user_id):
    page = request.args.get('page', 1, type=int)
    return jsonify({
        "success": True,
        "data": [a for a in ATTENDANCE_DATA if a['employee_id'] == user_id],
        "user_id": user_id
    }), 200

# Catch-all for undefined endpoints
@app.route('/<path:path>', methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
def catch_all(path):
    return jsonify({
        "success": False,
        "message": f"Endpoint /{path} not found"
    }), 404

if __name__ == '__main__':
    print("Starting mock server on http://127.0.0.1:5001")
    app.run(host='127.0.0.1', port=5001, debug=True)
