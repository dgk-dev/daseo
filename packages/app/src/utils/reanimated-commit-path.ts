/**
 * Daseo delta 87: keeps an animated container that moves tap targets on Reanimated's
 * shadow-tree commit path.
 *
 * The app turns on Reanimated's `ANDROID_SYNCHRONOUSLY_UPDATE_UI_PROPS` (package.json), so
 * transform, opacity and colour changes go straight to the native view without a shadow-tree
 * commit and layout. That is what stops the status rings and loader dots from re-laying out the
 * whole screen every frame. The shadow tree then lags behind what is drawn, and React Native's
 * Pressability measures a pressable from the shadow tree: a pressable inside a container that
 * slid in this way can cancel its `onPress` on the first touch move (Reanimated documents this
 * for the flag; it re-syncs settled styles only after a second).
 *
 * In `performOperations` Reanimated takes a view off the fast path as a whole as soon as its
 * animated style holds one property outside the fast-path set (`partitionUpdates` with
 * `allowPartialViews = false` in ReanimatedModuleProxy.cpp). `backfaceVisibility: "visible"` is
 * such a property and is Android's default, so spreading this into the animated style of a
 * container that moves pressables keeps it committed, with no visual change.
 */
export const SHADOW_TREE_COMMIT_PIN = { backfaceVisibility: "visible" } as const;
