import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import nodemailer from 'nodemailer';
import {labelConsultation} from './bm.studentConsultation.service.js';
import {isOfficialStudentUrl} from './bm.studentSources.js';
const html=value=>String(value||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
const required=name=>{if(!process.env[name])throw new Error(`Missing ${name}`);return process.env[name];};
export function consultationEmailMessage(booking) {
  const b=labelConsultation(booking);
  const subject=`${b.isDemo ? 'Demo consultation' : 'Consultation'} confirmed: ${b.serviceName}`;
  const links=b.includeSummary && Array.isArray(b.sourceLinks) ? b.sourceLinks.filter(isOfficialStudentUrl) : [];
  return {subject,html:`<div style="font-family:Arial,sans-serif;line-height:1.6;max-width:640px;margin:auto">
    <h2>${b.isDemo ? 'Demo student consultation booked' : 'Your student consultation is confirmed'}</h2>
    ${b.isDemo ? '<p><strong>Demonstration appointment only. No real adviser meeting has been arranged.</strong></p>' : ''}
    <p>Hi ${html(b.customerName)},</p>
    <p><strong>${html(b.serviceName)}</strong><br>Adviser: ${html(b.adviserName)}<br>
    ${html(b.startsAtLabel)} (${html(b.timeZone)})</p>
    <p>${html(b.meetingDetails)}</p><p>Reference: ${html(b.bookingId)}</p>
    ${b.includeSummary && b.enquirySummary ? `<h3>Your enquiry summary</h3><p>${html(b.enquirySummary)}</p>` : ''}
    ${links.length ? `<h3>Official information</h3><ul>${links.map(url=>`<li><a href="${html(url)}">${html(url)}</a></li>`).join('')}</ul>` : ''}
    <p>Contact the agency if you need to change your appointment.</p></div>`};
}
export async function sendStudentConsultationEmail(booking) {
  const message=consultationEmailMessage(booking);
  const provider=(process.env.EMAIL_PROVIDER||'ses').toLowerCase();
  if(provider==='log') {
    console.log('[STUDENT_CONSULTATION_EMAIL] Demo log only; no email delivered',booking.bookingId);
    return 'logged';
  }
  if(provider==='smtp') {
    const transport=nodemailer.createTransport({host:required('SMTP_HOST'),port:Number(required('SMTP_PORT')),secure:process.env.SMTP_SECURE==='true',
      connectionTimeout:10000,greetingTimeout:10000,socketTimeout:30000,
      auth:process.env.SMTP_USER ? {user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}:undefined});
    try {
      const result=await transport.sendMail({from:required('SMTP_FROM_EMAIL'),to:booking.customerEmail,...message});
      if(!result.accepted?.some(recipient=>String(recipient).toLowerCase()===booking.customerEmail.toLowerCase())) {
        throw new Error('SMTP did not accept the consultation recipient');
      }
    }
    finally{transport.close();}
  }else if(provider==='ses'){
    const client=new SESv2Client({region:process.env.AWS_REGION||process.env.SES_REGION||'ap-southeast-2'});
    try {await client.send(new SendEmailCommand({FromEmailAddress:process.env.SES_FROM_EMAIL||required('SES_FROM'),Destination:{ToAddresses:[booking.customerEmail]},
      Content:{Simple:{Subject:{Data:message.subject,Charset:'UTF-8'},Body:{Html:{Data:message.html,Charset:'UTF-8'}}}}}),{abortSignal:AbortSignal.timeout(30000)});}
    finally{client.destroy();}
  }else throw new Error('Unsupported consultation email provider');
  return 'sent';
}
