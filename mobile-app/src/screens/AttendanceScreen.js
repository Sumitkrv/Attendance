import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Location from "expo-location";

import { colors } from "../constants/theme";
import { markAttendance } from "../services/api";

export default function AttendanceScreen({ route }) {
  const userId = route?.params?.userId || "u_001";
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [locationPermission, setLocationPermission] = useState(false);
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState("Ready");
  const cameraRef = useRef(null);

  useEffect(() => {
    (async () => {
      if (!cameraPermission?.granted) {
        await requestCameraPermission();
      }
      const locResult = await Location.requestForegroundPermissionsAsync();
      setLocationPermission(locResult.status === "granted");
    })();
  }, [cameraPermission, requestCameraPermission]);

  const onSubmitAttendance = async () => {
    if (!cameraRef.current) return;
    setLoading(true);
    setStatusText("Capturing photo...");

    try {
      const picture = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.25,
        skipProcessing: true,
      });

      setStatusText("Getting location...");

      const lastKnown = await Location.getLastKnownPositionAsync();
      const freshPositionPromise = Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const freshOrTimeout = await Promise.race([
        freshPositionPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
      ]);
      const position = freshOrTimeout || lastKnown;

      if (!position) {
        throw new Error("Could not fetch location quickly. Please enable GPS and retry.");
      }

      setStatusText("Submitting attendance...");

      const payload = {
        user_id: userId,
        image_base64: picture.base64,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      };

      const response = await markAttendance(payload);
      Alert.alert("Success", response?.message || "Attendance marked");
    } catch (error) {
      const message = error?.response?.data?.detail || error?.message || "Failed to mark attendance";
      Alert.alert("Error", message);
    } finally {
      setStatusText("Ready");
      setLoading(false);
    }
  };

  if (!cameraPermission) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!cameraPermission.granted || !locationPermission) {
    return (
      <View style={styles.center}>
        <Text style={styles.info}>Camera and location permissions are required.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Attendance Verification</Text>
      <Text style={styles.subtitle}>Capture face + validate geofence</Text>

      <CameraView
        ref={cameraRef}
        style={styles.camera}
        facing="front"
        mute
      />

      <TouchableOpacity style={styles.button} onPress={onSubmitAttendance} disabled={loading}>
        <Text style={styles.buttonText}>{loading ? "Submitting..." : "Capture & Mark"}</Text>
      </TouchableOpacity>

      <Text style={styles.status}>{statusText}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    color: colors.text,
  },
  subtitle: {
    marginTop: 6,
    marginBottom: 12,
    color: colors.muted,
  },
  camera: {
    flex: 1,
    borderRadius: 14,
    overflow: "hidden",
    marginBottom: 14,
  },
  button: {
    height: 48,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
  },
  buttonText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 16,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
    padding: 20,
  },
  info: {
    color: colors.muted,
    textAlign: "center",
  },
  status: {
    marginTop: 10,
    color: colors.muted,
    textAlign: "center",
  },
});
