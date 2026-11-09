# Supervised phone renewal check

The current ApCiDa Beta phone credential was reported to expire on December 1, 2026. The app's daily connected maintenance job starts requesting renewal only during the final seven days. The backend applies the same seven-day window. A live renewal of this phone is therefore not expected on November 2. The server's disposable end-to-end renewal check already passed without using a phone or SMS.

## Check that Android scheduled background work now

On the friend's Windows PowerShell, with the phone connected by USB and ApCiDa Beta installed, run:

```powershell
adb shell dumpsys jobscheduler | Select-String 'com.apcida.smishingdetector.beta/androidx.work.impl.background.systemjob.SystemJobService' | Select-Object -First 10
```

This is read-only. It should show one or more WorkManager jobs for the beta package. With the app's current WorkManager 2.9.1, JobScheduler output does not reliably identify which job is `ProductionRenewalWorker`, so this check is useful but cannot by itself prove renewal was scheduled. Do not paste full device logs, invite codes, or service credentials into chat. If nothing appears, open ApCiDa Beta Settings while online, then repeat the command. The app schedules the renewal job on enrollment and when Settings opens.

On November 2, the friend's phone showed one active ApCiDa Beta WorkManager job with an approximately 24-hour minimum latency and a validated internet constraint. The app code defines only one periodic WorkManager request, the daily `ProductionRenewalWorker`. Together, these are strong evidence that renewal maintenance is scheduled on this phone. The job output did not expose the worker class and does not prove a renewal request completed.

## Check actual renewal near expiry

Starting approximately November 24, 2026, keep the phone online and open ApCiDa Beta Settings. Note the **Installation credential** expiry date, then check it again after a day. A renewed date later than December 1 is evidence that the phone received and saved the server's extended expiry. Keep the existing invite and service credentials private. Do not change the phone's clock or edit the active installation's database expiry to force a test. If the date has not extended by November 29, investigate while the current credential still works; an expired phone needs a fresh invite. No real SMS is needed for this check.

The Mac health monitor covers the Mac services, but it does not inspect Android WorkManager or guarantee that the phone completed renewal. Android can delay periodic work, especially when the phone is offline or restricted in the background.
