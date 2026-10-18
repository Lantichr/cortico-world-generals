Owner: [`src/proxy.ts`](../src/proxy.ts), [`compat/host-operator-pause.patch`](../compat/host-operator-pause.patch) and [`scripts/check-host-patch.ts`](../scripts/check-host-patch.ts).

# Host compatibility

Version `0.1.0-rc.1` targets **Cortico 0.2.3 / World API 6**. The published host supplies the APIs used by manual tools, observations and the local viewer. It does not supply the operator-pause lifecycle hook needed by autonomous S1.

| Host | Manual tools and viewer | Autonomous S1 |
| --- | --- | --- |
| Unmodified Cortico 0.2.3, API 6 | Available | `generals_start_agent` rejects delegation |
| Cortico 0.2.3 with the supplied pause patch | Available | Available for supported rules |
| API 5 host | Upgrade to API 6 before installing this package | Requires API 6 and the pause lifecycle |

The pause patch has **not been merged upstream**. Installing this npm package does not apply it. It is a patch for the Cortico host source, separate from the extension.

## Why S1 requires the hook

S1 runs in an engine child process and keeps acting while the model is idle or unavailable. Stopping event delivery to the model alone does not pause that process. The host must call `onOperatorPausedChanged(paused)` before `World.start()` and on later operator pause changes, including for hidden Worlds.

The proxy records the initial hook call. Without that handshake it rejects `generals_start_agent` before forwarding the delegation, and the World page shows the missing hook. Manual tools and the viewer remain usable. Apply the patch to a compatible source host, restart the entire host, then delegate again; restarting only the World cannot load changed Core code.

## Apply to a source host

The patch is based on the three Core source files distributed in npm `cortico@0.2.3`. Use a Cortico source checkout matching that version. Check the patch before applying it; a failed check requires reviewing the host's changes rather than forcing the patch.

From the **Cortico host repository root**, substitute the actual path to this extension checkout:

```sh
git apply --check /path/to/cortico-world-generals/compat/host-operator-pause.patch
git apply /path/to/cortico-world-generals/compat/host-operator-pause.patch
```

Review the diff and run that host's test and typecheck commands. Restart the host after those checks pass. The extension checker only checks construction and declarations; it does not establish runtime pause propagation.

The patch adds a generic optional World hook, WakeBus pause subscriptions and Core lifecycle forwarding. It supplies the current state before initial and dynamic starts, forwards changes during asynchronous startup, suppresses duplicate values and stops notifications after failed startup, unmount or Core shutdown. Hidden Worlds still receive pause changes. A throwing listener is logged without blocking other Worlds. Resume notifications run synchronously before queued events are delivered.

The patch contains no game-specific code, changes no deployment format and retains the host's MIT copyright and license. It does not change the extension API number. Later host releases require a new compatibility review; this patch is not a promise that their sources or lifecycle are identical.

## Verify the supplied patch

From this extension repository, after installing its development dependencies:

```sh
pnpm check:host-patch
```

This command requires Git and the pinned `cortico@0.2.3` development dependency. It copies the installed SDK into a fresh system temporary directory, runs `git apply --check`, applies the patch there, then uses the copied real Core and WakeBus with a self-contained Persona and a model client that rejects any model request. Checks cover initial running/paused states, duplicate values, resume ordering, hidden Worlds, initial and dynamic asynchronous startup, unmount/remount, startup failure, notification exceptions and shutdown. Installed SDK files are compared afterward and remain unchanged. The temporary copy and its run data are removed at the end.

No bot process is started and no external service is contacted. Passing these checks validates the supplied patch against the pinned SDK, not a different installed source host.

## World id and deployment migration

The extension registers `generals`. A host must have no in-tree or other extension registration with that id. Setting an existing World's `enabled=false` leaves its registration in place and does not resolve the conflict. Use a host distribution without the in-tree registration, or remove that registration from its source while preserving unrelated Worlds.

Retain the deployment's `worlds.generals` configuration, `CORTICO_GENERALS_USER_ID` in `.env`, and Memory. They do not need clearing or renaming. Stop the old World before starting the replacement so two connections do not use the same account. A new connection does not restore the previous room, vote, delegation or intent; inspect `generals_observe` and join again.
