# Attendance Mobile App (Expo)

## Install and run

1. Install dependencies:

   npm install

2. Configure backend URL:

   cp .env.example .env

3. Start Expo:

   npm run start

## Local IP connection

- Ensure phone and backend machine are on same Wi-Fi
- Set `EXPO_PUBLIC_API_BASE_URL=http://<YOUR_LOCAL_IP>:8000/api/v1`
- Backend must run with host `0.0.0.0`
