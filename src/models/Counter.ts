import mongoose, { Schema, Document } from "mongoose";

/**
 * Atomic sequence allocator.
 *
 * A read-max-then-increment scheme loses documents under concurrency: parallel
 * writers all read the same maximum and then collide on the unique index, and
 * retrying doesn't help because they re-read in lockstep. `$inc` inside
 * findOneAndUpdate is atomic in MongoDB, so each caller gets a distinct value on
 * the first try.
 *
 * `_id` is a caller-chosen key, e.g. "complaint-2026".
 */
// Document<string> because the _id here is a caller-chosen key, not an ObjectId.
export interface ICounter extends Document<string> {
  _id: string;
  seq: number;
}

const CounterSchema = new Schema<ICounter>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { versionKey: false },
);

const Counter = mongoose.model<ICounter>("Counter", CounterSchema);

/**
 * Reserve and return the next value for `key`.
 *
 * `seedFrom` is consulted only when the counter doesn't exist yet — it lets an
 * existing collection (or one that has just been backfilled) continue from its
 * current maximum instead of restarting at 1.
 */
export async function nextSequence(
  key: string,
  seedFrom?: () => Promise<number>,
): Promise<number> {
  const bumped = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { new: true },
  );
  if (bumped) return bumped.seq;

  // First use of this key: seed it, then take a number. $setOnInsert makes the
  // seed idempotent, so simultaneous first-callers still end up with distinct
  // values from the $inc below.
  const start = seedFrom ? await seedFrom() : 0;
  await Counter.updateOne(
    { _id: key },
    { $setOnInsert: { seq: start } },
    { upsert: true },
  );

  const created = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  );
  return created!.seq;
}

export default Counter;
