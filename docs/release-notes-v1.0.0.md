# SecurityOps Platform 1.0.0

The platform now covers all 20 planned modules across authentication, master data, alarms,
patrols, sensors, GPS, incidents, NSL operations, communication, reporting, TimeScan,
NFC device inventory, auditing, privacy and backup operations.

Deployment must provide `.env.production` from a secret store, run the production compose
file, configure SMTP/SMS/TimeScan providers and execute a backup/restore drill before
handling live operational data.
