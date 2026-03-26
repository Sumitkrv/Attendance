import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { colors } from "../constants/theme";

export default function HomeScreen({ navigation, route }) {
  const userId = route?.params?.userId || "u_001";

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.welcome}>Welcome</Text>
        <Text style={styles.user}>User: {userId}</Text>

        <TouchableOpacity style={styles.button} onPress={() => navigation.navigate("Attendance", { userId })}>
          <Text style={styles.buttonText}>Mark Attendance</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    padding: 20,
    backgroundColor: colors.bg,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.border,
  },
  welcome: {
    fontSize: 24,
    fontWeight: "700",
    color: colors.text,
  },
  user: {
    marginTop: 8,
    marginBottom: 20,
    color: colors.muted,
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
});
