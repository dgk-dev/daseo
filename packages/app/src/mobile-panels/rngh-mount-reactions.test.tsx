/**
 * @vitest-environment jsdom
 */
import React, { useLayoutEffect, useRef } from "react";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MountRegistry } from "react-native-gesture-handler/src/mountRegistry";
import { useMountReactions } from "react-native-gesture-handler/src/handlers/gestures/GestureDetector/useMountReactions";

// Regression test for patches/react-native-gesture-handler+2.28.0.patch (backport of
// software-mansion/react-native-gesture-handler#4268). On the phone the whole app fell into
// RootErrorBoundary with "Unable to find node on an unmounted component" from
// attachHandlers -> MountRegistry.gestureWillMount -> forEach -> mount listener -> updateDetector
// -> findNodeHandle, under MobilePanelOverlay's GestureDetector.
//
// The window: when one GestureDetector unmounts and a related one mounts in the same commit,
// React runs the old detector's layout cleanup (isMounted = false) before the new detector's
// layout effect (attachHandlers -> gestureWillMount), but removes the old detector's mount
// listener only later, with passive effects. The harness below copies GestureDetector's effect
// order from node_modules/react-native-gesture-handler/src/handlers/gestures/GestureDetector/index.tsx
// and uses the real useMountReactions and MountRegistry.

const UNMOUNTED_NODE_ERROR = "Unable to find node on an unmounted component.";

interface FakeGesture {
  handlerTag: number;
  config: { simultaneousWith?: { current: unknown }[] };
}

// Gestures and the update log live outside props so each detector receives only its name.
const gestures = new Map<string, FakeGesture>();
const updates: number[] = [];

function HarnessDetector({ name }: { name: string }) {
  const gesture = gestures.get(name)!;
  const preparedGesture = useRef({
    attachedGestures: [gesture],
    animatedEventHandler: null,
    animatedHandlers: null,
    shouldUseReanimated: false,
    isMounted: false,
  }).current;

  // Stands in for useDetectorUpdater's callback, which calls findNodeHandle(viewRef).
  const updateDetector = useRef(() => {
    if (!preparedGesture.isMounted) {
      throw new Error(UNMOUNTED_NODE_ERROR);
    }
    updates.push(gesture.handlerTag);
  }).current;

  useLayoutEffect(() => {
    preparedGesture.isMounted = true;
    // attachHandlers announces the mounting gesture to every registered detector.
    MountRegistry.gestureWillMount(gesture as never);
    return () => {
      preparedGesture.isMounted = false;
    };
  }, [gesture, preparedGesture]);

  useMountReactions(updateDetector, preparedGesture as never);
  return null;
}

// react-native-web reports Platform.OS === "web", where relations resolve through ref.current.
function relationTo(gesture: FakeGesture): { current: unknown } {
  return { current: gesture.handlerTag };
}

describe("react-native-gesture-handler mount reactions (RNGH #4268 backport)", () => {
  const mounted: { unmount: () => void }[] = [];
  afterEach(() => {
    for (const view of mounted.splice(0)) {
      view.unmount();
    }
    gestures.clear();
    updates.length = 0;
  });

  it("does not update a detector that unmounted in the same commit a related gesture mounts", () => {
    const incoming: FakeGesture = { handlerTag: 202, config: {} };
    gestures.set("incoming", incoming);
    gestures.set("outgoing", {
      handlerTag: 101,
      config: { simultaneousWith: [relationTo(incoming)] },
    });

    const view = render(<HarnessDetector key="outgoing" name="outgoing" />);
    mounted.push(view);

    expect(() => view.rerender(<HarnessDetector key="incoming" name="incoming" />)).not.toThrow();
    expect(updates).toEqual([]);
  });

  it("still updates a mounted detector when a related gesture mounts", () => {
    const incoming: FakeGesture = { handlerTag: 404, config: {} };
    gestures.set("incoming", incoming);
    gestures.set("resident", {
      handlerTag: 303,
      config: { simultaneousWith: [relationTo(incoming)] },
    });

    const view = render(<HarnessDetector key="resident" name="resident" />);
    mounted.push(view);
    view.rerender(
      <>
        <HarnessDetector key="resident" name="resident" />
        <HarnessDetector key="incoming" name="incoming" />
      </>,
    );

    expect(updates).toEqual([303]);
  });
});
