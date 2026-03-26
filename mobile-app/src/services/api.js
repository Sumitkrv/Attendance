import Constants from "expo-constants";
import axios from "axios";

const apiBaseUrl =
  process.env.EXPO_PUBLIC_API_BASE_URL ||
  Constants?.expoConfig?.extra?.apiBaseUrl ||
  "http://192.168.1.28:8000/api/v1";

const api = axios.create({
  baseURL: apiBaseUrl,
  timeout: 8000,
  headers: {
    "Content-Type": "application/json",
  },
});

export async function login(email, password) {
  const { data } = await api.post("/login", { email, password });
  return data;
}

export async function markAttendance(payload) {
  const { data } = await api.post("/mark-attendance", payload);
  return data;
}

export async function getAttendanceHistory(userId) {
  const { data } = await api.get(`/attendance-history/${userId}`);
  return data;
}

export default api;
