import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IAuditLog extends Document {
  admin: Types.ObjectId;
  action: string;
  entity: string;
  entityId: string;
  changes: Record<string, any>;
  createdAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    admin: { type: Schema.Types.ObjectId, ref: 'Admin', required: true },
    action: { type: String, required: true }, // 'create' | 'update' | 'delete'
    entity: { type: String, required: true }, // 'plot' | 'payment' | 'notice'
    entityId: { type: String, required: true },
    changes: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
  }
);

AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ entity: 1, entityId: 1 });

export default mongoose.model<IAuditLog>('AuditLog', AuditLogSchema);
