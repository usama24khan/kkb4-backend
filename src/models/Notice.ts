import mongoose, { Schema, Document, Types } from 'mongoose';

export interface INotice extends Document {
  type: 'plot' | 'block' | 'phase';
  targetId: string;
  year: number;
  monthFrom: string;
  monthTo: string;
  generatedBy: Types.ObjectId;
  plotCount: number;
  totalDue: number;
  pdfPath: string;
  createdAt: Date;
}

const NoticeSchema = new Schema<INotice>(
  {
    type: { type: String, enum: ['plot', 'block', 'phase'], required: true },
    targetId: { type: String, required: true },
    year: { type: Number, required: true },
    monthFrom: { type: String, default: 'jan' },
    monthTo: { type: String, default: 'dec' },
    generatedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
    plotCount: { type: Number, default: 1 },
    totalDue: { type: Number, default: 0 },
    pdfPath: { type: String, default: '' },
  },
  {
    timestamps: true,
  }
);

NoticeSchema.index({ createdAt: -1 });

export default mongoose.model<INotice>('Notice', NoticeSchema);
