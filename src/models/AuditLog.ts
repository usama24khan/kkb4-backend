import mongoose, { Schema, Document, Types } from 'mongoose';

/** One field that changed, kept in a shape that can be read back as a sentence. */
export interface IAuditChange {
  /** Machine name of what changed: `payments.aug`, `ownerName`, `amount`. */
  field: string;
  /** Value before, `null` when the field did not exist. */
  from: any;
  /** Value after. */
  to: any;
}

export interface IAuditLog extends Document {
  admin: Types.ObjectId;
  action: string;
  entity: string;
  entityId: string;
  /**
   * The plot this touched, when there is one.
   *
   * Payment and receipt entries are keyed by their own id, so without this a
   * plot's history could not show the money changes made against it — which is
   * most of what anyone opens an audit trail to see.
   */
  plot?: Types.ObjectId;
  /** A one-line description written when the entry was recorded. */
  summary?: string;
  /** Field-level before and after, for the ones worth listing. */
  diffs?: IAuditChange[];
  /** The raw record of the request, kept as the underlying evidence. */
  changes: Record<string, any>;
  createdAt: Date;
}

const AuditChangeSchema = new Schema<IAuditChange>(
  {
    field: { type: String, required: true },
    from: { type: Schema.Types.Mixed, default: null },
    to: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const AuditLogSchema = new Schema<IAuditLog>(
  {
    admin: { type: Schema.Types.ObjectId, ref: 'Admin', required: true },
    action: { type: String, required: true }, // 'create' | 'update' | 'delete' | 'void' | ...
    entity: { type: String, required: true }, // 'plot' | 'payment' | 'collection' | 'notice'
    entityId: { type: String, required: true },
    plot: { type: Schema.Types.ObjectId, ref: 'Plot', default: null },
    summary: { type: String, default: '' },
    diffs: { type: [AuditChangeSchema], default: [] },
    changes: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
  }
);

AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ entity: 1, entityId: 1 });
AuditLogSchema.index({ plot: 1, createdAt: -1 });

export default mongoose.model<IAuditLog>('AuditLog', AuditLogSchema);
