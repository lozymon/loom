// Pairing screen — scan the QR the laptop shows (Settings → Remote), or paste the code. The key
// never touches the network in the clear; it seals every frame from here on. Manual paste exists so
// pairing is testable without a camera.

import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { parsePairingPayload, savePairing, type Pairing } from "../state/pairing";
import { C } from "../theme";

export default function PairScreen({ onPaired }: { onPaired: (p: Pairing) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  async function accept(raw: string) {
    try {
      const info = parsePairingPayload(raw);
      const paired = await savePairing(info);
      onPaired(paired);
    } catch (e) {
      setError((e as Error).message);
      setScanning(false);
    }
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Pair with Loom</Text>
      <Text style={styles.body}>
        On your laptop, open Loom → Settings → Remote and show the pairing QR. Scan it once — the key
        stays on this device and seals everything you send.
      </Text>

      {scanning && permission?.granted ? (
        <View style={styles.scanner}>
          <CameraView
            style={StyleSheet.absoluteFill}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => accept(data)}
          />
        </View>
      ) : (
        <Pressable
          style={styles.primary}
          onPress={async () => {
            if (!permission?.granted) {
              const r = await requestPermission();
              if (!r.granted) return setError("Camera permission is needed to scan the QR.");
            }
            setError(null);
            setScanning(true);
          }}
        >
          <Text style={styles.primaryText}>Scan QR</Text>
        </Pressable>
      )}

      <Text style={styles.or}>or paste the code</Text>
      <TextInput
        style={styles.input}
        placeholder='{"url":"ws://…","key":"…"}'
        placeholderTextColor={C.textFaint}
        value={manual}
        onChangeText={setManual}
        autoCapitalize="none"
        multiline
      />
      <Pressable style={styles.secondary} onPress={() => accept(manual)}>
        <Text style={styles.secondaryText}>Pair from code</Text>
      </Pressable>

      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.canvas, padding: 24, gap: 16, justifyContent: "center" },
  title: { color: C.textBright, fontSize: 26, fontWeight: "600" },
  body: { color: C.textMid, fontSize: 15, lineHeight: 21 },
  scanner: { height: 260, borderRadius: 16, overflow: "hidden", borderWidth: 1, borderColor: C.hairline },
  primary: { backgroundColor: C.surface, borderColor: C.accent, borderWidth: 1, borderRadius: 12, padding: 14, alignItems: "center" },
  primaryText: { color: C.accentText, fontSize: 16, fontWeight: "600" },
  or: { color: C.textDim, textAlign: "center", fontSize: 13 },
  input: { backgroundColor: C.surface, color: C.textBright, borderColor: C.hairline, borderWidth: 1, borderRadius: 10, padding: 12, fontFamily: "monospace", minHeight: 64 },
  secondary: { borderColor: C.hairline, borderWidth: 1, borderRadius: 12, padding: 12, alignItems: "center" },
  secondaryText: { color: C.textMid, fontSize: 15, fontWeight: "600" },
  error: { color: C.dead, fontSize: 14 },
});
