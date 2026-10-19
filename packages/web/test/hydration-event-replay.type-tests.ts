import { generateHydrationScript, HydrationScript } from "../src/server.js";
import {
  generateHydrationScript as clientScript,
  HydrationScript as ClientScript
} from "../src/client.js";

generateHydrationScript({ eventReplayAttribute: "data-hydration-events" });
HydrationScript({ eventReplayAttribute: "data-custom-events" });
clientScript({ eventReplayAttribute: "data-hydration-events" });
ClientScript({ eventReplayAttribute: "data-custom-events" });

// @ts-expect-error The public contract accepts an attribute name, not executable policy.
generateHydrationScript({ eventReplayAttribute: () => true });
