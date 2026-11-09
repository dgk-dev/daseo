import { useLayoutEffect, useState } from "react";
import { makeMutable, type SharedValue, useSharedValue } from "react-native-reanimated";
import { scheduleOnUI } from "react-native-worklets";
import { getStatusRingRotation } from "@/components/status-ring/geometry";

/** Where a ring rests when it does not turn: reduce motion, or before it first shows. */
export const STATIC_STATUS_RING_ROTATION = 0;

const sharedRotation = makeMutable(getStatusRingRotation(Date.now()));
const activeRingCount = makeMutable(0);
const clockRunning = makeMutable(false);
let nextRingListenerId = 1;

function advanceSharedRotation(): void {
  "worklet";
  if (activeRingCount.value === 0) {
    clockRunning.value = false;
    return;
  }

  sharedRotation.value = getStatusRingRotation(Date.now());
  requestAnimationFrame(advanceSharedRotation);
}

function registerStatusRing(
  rotation: SharedValue<number>,
  registered: SharedValue<boolean>,
  listenerId: number,
): void {
  "worklet";
  if (registered.value) {
    return;
  }

  registered.value = true;
  rotation.value = getStatusRingRotation(Date.now());
  sharedRotation.addListener(listenerId, (nextRotation) => {
    rotation.value = nextRotation;
  });
  activeRingCount.value += 1;

  if (!clockRunning.value) {
    clockRunning.value = true;
    sharedRotation.value = rotation.value;
    requestAnimationFrame(advanceSharedRotation);
  }
}

function unregisterStatusRing(registered: SharedValue<boolean>, listenerId: number): void {
  "worklet";
  if (!registered.value) {
    return;
  }

  registered.value = false;
  sharedRotation.removeListener(listenerId);
  activeRingCount.value -= 1;
}

/**
 * One UI-thread clock turns every visible ring in phase. Daseo delta 87: a ring follows it only
 * while its retained panel is on screen and reduce motion is off. Each ring keeps its own value
 * so a ring in a hidden retained panel (another workspace, a closed sidebar) neither keeps the
 * clock running nor re-renders on its frames, and reduce motion leaves the ring still, like the
 * loader dots.
 */
export function useStatusRingRotation(active: boolean, reduceMotion: boolean): SharedValue<number> {
  const rotation = useSharedValue(
    reduceMotion ? STATIC_STATUS_RING_ROTATION : getStatusRingRotation(Date.now()),
  );
  const registered = useSharedValue(false);
  const [listenerId] = useState(() => nextRingListenerId++);

  useLayoutEffect(() => {
    if (!active || reduceMotion) {
      return;
    }

    scheduleOnUI(registerStatusRing, rotation, registered, listenerId);
    return () => {
      scheduleOnUI(unregisterStatusRing, registered, listenerId);
    };
  }, [active, listenerId, reduceMotion, registered, rotation]);

  return rotation;
}
