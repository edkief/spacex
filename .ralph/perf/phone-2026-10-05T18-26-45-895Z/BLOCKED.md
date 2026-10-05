BLOCKED-PENDING-DEVICE (phone)
------------------------------
No phone was reachable from this environment (checked: adb device list,
Chrome DevTools Protocol on 127.0.0.1:9222). SC-4 (30 fps mobile floor)
is UNVERIFIED, not passed. To run the phone section later:

  1. Connect the reference phone (mid-range 2023+, 8 GB, mid SoC) and
     enable USB debugging, then:
       adb devices                      # must list the phone
       adb reverse tcp:9222 tcp:9222    # expose the phone's Chrome to the host
     (or run a local Android build of the app, or connect an iPhone over
     USB with Safari Remote Inspection and a CDP bridge such as
     ios-webkit-debug-proxy + openinspector.)
  2. From the phone's Chrome, open http://localhost:3000 with the mobile
     viewport (the Mobile profile is chosen by the client's feature
     detection; force it with ?profile=mobile if available).
  3. Run the suite:
       npm run perf:report phone        # from the app/ directory
     which runs bench:transitions, bench:render (Mobile profile), bench:tick,
     load:smoke + the reduced-FX keyboard-only loop (tests/e2e/
     mobile-profile.spec.ts, Mobile profile forced — TASK-54/59) connected
     over CDP, and records the same .ralph/perf/ artifacts.
  4. The acceptance gates for the phone rows (docs/performance.md):
     render benchmark reduced scene, Mobile profile, no atmosphere dome:
     median frame <= 33 ms (>= 30 fps); keyboard-only loop: no dropped
     frame > 100 ms.
