from pathlib import Path
from pymongo import MongoClient


def read_env(path: Path) -> dict:
    out = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def main() -> None:
    env = read_env(Path('/Users/sumitthakur/Downloads/Attendance-main/backend/.env'))
    uri = env.get('MONGODB_URI', 'mongodb://localhost:27017')
    db_name = env.get('MONGODB_DB', 'face_attendance')

    client = MongoClient(uri, serverSelectionTimeoutMS=3000)
    db = client[db_name]

    titles = [
        'hmmm', 'huhh', 'helo', 'karo', 'kaam karna hai', 'han', 'edekho', 'hello',
        'Attendance Software', 'work1', 'hoi', 'work2', 'hoiii', 'hiii', 'hi', 'nachio',
        'hmm', 'thak gya bhaai', 'ACHIAA', 'work', 'KAM karo. bc', 'done', 'attendacne',
        'hnn', 'attendance ui', 'mar jaye duniya bc', 'SUN LE AB', 'priyanka be buddhi',
        'chutiya pr',
    ]

    query = {
        'title': {'$in': titles},
        'status': 'approved',
    }

    matched_before = db.tasks.count_documents(query)
    result = db.tasks.delete_many(query)
    remaining = db.tasks.count_documents(query)

    print({
        'matched_before': matched_before,
        'deleted': result.deleted_count,
        'remaining': remaining,
    })


if __name__ == '__main__':
    main()
