import PDFDocument from 'pdfkit';
import { MONTH_NAMES, BLOCK_PHASE_MAP } from '../config/constants';
import { IPlot } from '../models/Plot';
import { IPayment } from '../models/Payment';
import path from 'path';
import fs from 'fs';

interface NoticeData {
  plot: IPlot;
  payments: IPayment[];
  year: number;
  noticeNumber: number;
}

const NOTICES_DIR = path.join(__dirname, '../../notices');

// Ensure notices directory exists
if (!fs.existsSync(NOTICES_DIR)) {
  fs.mkdirSync(NOTICES_DIR, { recursive: true });
}

export function generatePlotNotice(data: NoticeData): Promise<string> {
  return new Promise((resolve, reject) => {
    const { plot, payments, year, noticeNumber } = data;
    const fileName = `notice_${noticeNumber}_${plot.plotBlock.replace(/\s/g, '_')}_${year}.pdf`;
    const filePath = path.join(NOTICES_DIR, fileName);
    
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(filePath);
    
    doc.pipe(stream);
    
    // === HEADER / LETTERHEAD ===
    doc.fontSize(20).font('Helvetica-Bold')
      .text('KKB4 Housing Society', { align: 'center' });
    doc.fontSize(10).font('Helvetica')
      .text('Maintenance Fee Collection Office', { align: 'center' });
    doc.text('Contact: admin@kkb4.com', { align: 'center' });
    doc.moveDown();
    
    // Divider line
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown();
    
    // === NOTICE DETAILS ===
    doc.fontSize(14).font('Helvetica-Bold')
      .text('MAINTENANCE FEE NOTICE', { align: 'center' });
    doc.moveDown(0.5);
    
    doc.fontSize(10).font('Helvetica');
    doc.text(`Notice No: ${noticeNumber}`, { align: 'left' });
    doc.text(`Date: ${new Date().toLocaleDateString('en-GB')}`, { align: 'left' });
    doc.moveDown();
    
    // === OWNER DETAILS ===
    doc.fontSize(11).font('Helvetica-Bold').text('Owner Details:');
    doc.fontSize(10).font('Helvetica');
    doc.text(`Name: ${plot.ownerName}`);
    doc.text(`Plot Number: ${plot.plotNumber}`);
    doc.text(`Block: ${plot.block}`);
    doc.text(`Phase: ${plot.phase}`);
    doc.text(`Status: ${plot.allotmentStatus}`);
    doc.moveDown();
    
    // === PAYMENT TABLE ===
    const payment = payments.find(p => p.year === year);
    
    if (payment) {
      doc.fontSize(11).font('Helvetica-Bold')
        .text(`Payment Record — Year ${year}`);
      doc.moveDown(0.5);
      
      doc.fontSize(10).font('Helvetica');
      doc.text(`Monthly Maintenance Charge: PKR ${payment.mcRate}/month`);
      doc.moveDown(0.5);
      
      // Table header
      const tableTop = doc.y;
      const colWidths = [130, 100, 100, 100];
      const headers = ['Month', 'Due (PKR)', 'Paid (PKR)', 'Status'];
      
      doc.font('Helvetica-Bold');
      let xPos = 50;
      headers.forEach((header, i) => {
        doc.text(header, xPos, tableTop, { width: colWidths[i], align: 'left' });
        xPos += colWidths[i];
      });
      
      doc.moveTo(50, tableTop + 15).lineTo(545, tableTop + 15).stroke();
      
      // Table rows
      doc.font('Helvetica');
      let yPos = tableTop + 20;
      const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
      
      for (const month of months) {
        const paid = (payment.payments as any)[month] || 0;
        const status = paid >= payment.mcRate ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid';
        
        xPos = 50;
        doc.text(MONTH_NAMES[month] || month, xPos, yPos, { width: colWidths[0] });
        xPos += colWidths[0];
        doc.text(`${payment.mcRate}`, xPos, yPos, { width: colWidths[1] });
        xPos += colWidths[1];
        doc.text(`${paid}`, xPos, yPos, { width: colWidths[2] });
        xPos += colWidths[2];
        doc.text(status, xPos, yPos, { width: colWidths[3] });
        
        yPos += 18;
      }
      
      doc.moveTo(50, yPos).lineTo(545, yPos).stroke();
      yPos += 10;
      
      // Summary
      doc.font('Helvetica-Bold');
      doc.text(`Total Due: PKR ${payment.totalDue}`, 50, yPos);
      yPos += 15;
      doc.text(`Total Received: PKR ${payment.totalReceived}`, 50, yPos);
      yPos += 15;
      doc.fontSize(12)
        .text(`Outstanding Amount: PKR ${payment.remaining}`, 50, yPos);
      doc.moveDown(2);
    }
    
    // === PAYMENT INSTRUCTIONS ===
    doc.fontSize(11).font('Helvetica-Bold')
      .text('Payment Instructions:');
    doc.fontSize(10).font('Helvetica');
    doc.text('Please deposit your maintenance fee at the KKB4 Society Office.');
    doc.text('Bank: [Bank Name] | Account: [Account Number]');
    doc.text('Office Hours: Monday–Saturday, 9:00 AM – 5:00 PM');
    doc.moveDown(2);
    
    // === SIGNATURE ===
    doc.text('_________________________', 350, doc.y, { align: 'right' });
    doc.text('Secretary / Chairman', 350, doc.y + 5, { align: 'right' });
    doc.text('KKB4 Housing Society', 350, doc.y + 5, { align: 'right' });
    
    // === URDU SECTION ===
    doc.addPage();
    doc.fontSize(16).font('Helvetica-Bold')
      .text('KKB4 Housing Society - Maintenance Notice', { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).font('Helvetica')
      .text('(Urdu translation section - requires Noto Nastaliq Urdu font)', { align: 'center' });
    doc.moveDown();
    doc.text(`Plot: ${plot.plotBlock} | Owner: ${plot.ownerName} | Year: ${year}`, { align: 'center' });
    if (payment) {
      doc.text(`Total Due: PKR ${payment.totalDue} | Paid: PKR ${payment.totalReceived} | Remaining: PKR ${payment.remaining}`, { align: 'center' });
    }
    
    doc.end();
    
    stream.on('finish', () => resolve(filePath));
    stream.on('error', reject);
  });
}

export function generateBulkNotices(
  plotsWithPayments: Array<{ plot: IPlot; payments: IPayment[] }>,
  year: number,
  startNoticeNumber: number
): Promise<string[]> {
  const promises = plotsWithPayments.map((item, idx) =>
    generatePlotNotice({
      plot: item.plot,
      payments: item.payments,
      year,
      noticeNumber: startNoticeNumber + idx,
    })
  );
  return Promise.all(promises);
}
