// MUST be first — polyfills global `crypto.getRandomValues`, which React Native/Hermes doesn't
// provide. lanClient's randomSalt() (and @noble) need it; without it the LanBridgeClient constructor
// throws and the app hangs on "Connecting…".
import "react-native-get-random-values";
import { registerRootComponent } from "expo";
import App from "./App";

registerRootComponent(App);
