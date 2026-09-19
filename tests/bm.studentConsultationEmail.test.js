import {afterEach,expect,it,jest} from '@jest/globals';
const send=jest.fn();const destroy=jest.fn();const create=jest.fn();const sendMail=jest.fn();const close=jest.fn();
jest.unstable_mockModule('@aws-sdk/client-sesv2',()=>({SESv2Client:class{constructor(options){create(options);}send=send;destroy=destroy;},SendEmailCommand:class{constructor(input){this.input=input;}}}));
jest.unstable_mockModule('nodemailer',()=>({default:{createTransport:()=>({sendMail,close})}}));
jest.unstable_mockModule('../src/config/db.js',()=>({default:{}}));
const {sendStudentConsultationEmail}=await import('../src/services/bm.studentConsultationEmail.service.js');
const original={...process.env};
afterEach(()=>{process.env={...original};jest.clearAllMocks();});
const booking={bookingId:'demo',customerName:'Demo',customerEmail:'demo@example.com',startsAt:'2026-10-01T00:00:00Z',timeZone:'Australia/Brisbane',isDemo:true,serviceName:'Demo consultation',includeSummary:false};
it('uses the existing legacy SES configuration and confirmed recipient without attachments',async()=>{
 process.env.EMAIL_PROVIDER='ses';delete process.env.SES_FROM_EMAIL;delete process.env.AWS_REGION;process.env.SES_FROM='demo@agency.example';process.env.SES_REGION='ap-southeast-2';send.mockResolvedValue({MessageId:'test'});
 expect(await sendStudentConsultationEmail(booking)).toBe('sent');expect(create).toHaveBeenCalledWith({region:'ap-southeast-2'});
 expect(send.mock.calls[0][0].input).toMatchObject({FromEmailAddress:'demo@agency.example',Destination:{ToAddresses:['demo@example.com']}});
 expect(send.mock.calls[0][0].input.Content.Raw).toBeUndefined();expect(destroy).toHaveBeenCalled();
});
it('prefers current SES settings and propagates provider errors',async()=>{
 process.env.EMAIL_PROVIDER='ses';process.env.SES_FROM_EMAIL='current@agency.example';process.env.SES_FROM='legacy@agency.example';process.env.AWS_REGION='us-east-1';send.mockRejectedValueOnce(new Error('SES rejected'));
 await expect(sendStudentConsultationEmail(booking)).rejects.toThrow('SES rejected');expect(create).toHaveBeenCalledWith({region:'us-east-1'});expect(destroy).toHaveBeenCalled();
});
it('does not claim sent when SMTP rejects the recipient',async()=>{
 Object.assign(process.env,{EMAIL_PROVIDER:'smtp',SMTP_HOST:'test',SMTP_PORT:'587',SMTP_FROM_EMAIL:'demo@agency.example'});sendMail.mockResolvedValue({accepted:[],rejected:['demo@example.com']});
 await expect(sendStudentConsultationEmail(booking)).rejects.toThrow('did not accept');expect(close).toHaveBeenCalled();
});
it('accepts a successful SMTP response and closes the transport',async()=>{
 Object.assign(process.env,{EMAIL_PROVIDER:'smtp',SMTP_HOST:'test',SMTP_PORT:'587',SMTP_FROM_EMAIL:'demo@agency.example'});sendMail.mockResolvedValue({accepted:['demo@example.com']});
 expect(await sendStudentConsultationEmail(booking)).toBe('sent');expect(close).toHaveBeenCalled();
});
