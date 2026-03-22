import os
from datetime import datetime

from dotenv import load_dotenv
from pymongo import ASCENDING, MongoClient


def main():
    load_dotenv()

    mongo_uri = os.getenv("MONGODB_URI", "").strip()
    db_name = os.getenv("MONGODB_DB", "face_attendance").strip() or "face_attendance"

    if not mongo_uri:
        raise SystemExit("MONGODB_URI is empty. Set it in backend/.env")

    client = MongoClient(mongo_uri, serverSelectionTimeoutMS=5000)
    client.admin.command("ping")
    db = client[db_name]

    db.employees.create_index([("name", ASCENDING)], unique=True)
    db.employees.create_index([("login_id", ASCENDING)], unique=True, sparse=True)
    db.attendance.create_index([("employee_id", ASCENDING), ("date", ASCENDING)], unique=True)

    print("✅ Atlas preflight OK")
    print(f"db={db_name}")
    print(f"employees={db.employees.count_documents({})}")
    print(f"attendance={db.attendance.count_documents({})}")
    print(f"time={datetime.now().isoformat()}")


if __name__ == "__main__":
    main()
