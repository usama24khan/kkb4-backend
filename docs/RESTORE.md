# Restoring the database from a backup

The nightly workflow (`.github/workflows/backup.yml`) produces one encrypted
archive per day. This is how to read one back.

**Do the drill once now, and once a year after that.** A backup nobody has ever
restored is a hope, not a backup — and the day you need it is the worst day to
discover the passphrase was wrong.

## What you need

- the archive: Actions → *Backup database* → pick a run → download the artifact
  (or take a file from the long-term backup repo, if one is configured)
- `BACKUP_PASSPHRASE` — the value stored **outside** GitHub
- MongoDB database tools (`mongorestore`), and a target connection string

## 1. Decrypt

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
  -in kkb4-2026-09-18.archive.gz.enc \
  -out kkb4.archive.gz \
  -pass pass:'<BACKUP_PASSPHRASE>'
```

Wrong passphrase gives `bad decrypt`. Nothing else does.

## 2. Look before restoring

```bash
mongorestore --gzip --archive=kkb4.archive.gz --dryRun --verbose=1
```

Lists every collection and document count without writing anything. The nightly
workflow runs exactly this on each archive, so a failure here means the archive
is damaged rather than the passphrase being wrong.

## 3. Restore into a SCRATCH database first

Never restore straight over live data — not even to "just check". Give it a new
database name:

```bash
mongorestore --gzip --archive=kkb4.archive.gz \
  --nsFrom='kkb4production.*' --nsTo='kkb4restoretest.*' \
  --uri="<MONGODB_URI>"
```

Then confirm the receipts are really there and really readable:

```bash
mongosh "<MONGODB_URI>" --eval '
  const db = db.getSiblingDB("kkb4restoretest");
  print("receipts:", db.receipts.countDocuments());
  print("payments:", db.payments.countDocuments());
  print("plots:", db.plots.countDocuments());
  printjson(db.receipts.find().sort({createdAt:-1}).limit(1).toArray());
'
```

The real test is whether a receipt **prints**: point a local backend at the
scratch database and open one receipt PDF. Receipt PDFs are rebuilt from these
rows, so a receipt that renders proves the backup carries what matters.

Drop the scratch database when you are done.

## 4. Only then, a real restore

If the live data genuinely has to be replaced:

1. Stop writes — take the admin app offline so nobody records a payment that the
   restore is about to overwrite.
2. Rename rather than delete: restore into `kkb4production_restored`, check it,
   then switch `MONGODB_URI` to point at it. That keeps the damaged database for
   forensics instead of destroying the evidence.
3. Watch out for the counters. `counters` holds the receipt-number sequences
   (`receipt-2026`, …). If a restore rolls the database back, the counter goes
   back with it and the next receipt could reuse a number that was already handed
   to an owner. After any restore, check:

```bash
mongosh "<MONGODB_URI>" --eval '
  const db = db.getSiblingDB("<restored db>");
  db.receipts.aggregate([
    {$group: {_id: "$year", maxIssued: {$max: "$receiptNumericId"}}}
  ]).forEach(r => {
    const c = db.counters.findOne({_id: "receipt-" + r._id});
    print(`${r._id}: highest issued ${r.maxIssued}, counter ${c ? c.seq : "missing"}`);
  });
'
```

Any counter lower than the highest issued number must be raised to match:

```bash
db.counters.updateOne({_id:"receipt-2026"}, {$set:{seq:<highest issued>}}, {upsert:true})
```

## What a restored backup will NOT bring back

- **Receipt PDFs older than a year** — deleted by the retention job on purpose.
  They rebuild from the restored rows the first time someone opens them, so
  nothing is lost.
- **Notice PDFs older than 180 days** — also deleted on purpose, and these do
  *not* rebuild: the per-plot dues table a notice printed was never stored. The
  notice row still records who was served, when, and for how much.
