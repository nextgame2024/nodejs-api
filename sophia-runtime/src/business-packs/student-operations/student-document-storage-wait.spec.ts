import {afterEach,describe,expect,it,jest} from '@jest/globals';
import {BadGatewayException,ConflictException} from '@nestjs/common';
import {waitForStudentDocumentStorage} from './student-document-storage-wait.js';

const pending=()=>new ConflictException({errorCode:'student_document_storage_pending'});
afterEach(()=>jest.useRealTimers());
describe('concurrent document storage setup',()=>{
  it('lets concurrent files reuse the completed contact without starting more provisioning',async()=>{
    jest.useFakeTimers();let contact:string|null=null,creating=false,creations=0;
    const prepare=async()=>{
      if(contact)return contact;
      if(creating)throw pending();
      creating=true;creations++;
      await new Promise(resolve=>globalThis.setTimeout(resolve,600));
      contact='shared-contact';return contact;
    };
    const result=Promise.all([1,2,3].map(()=>waitForStudentDocumentStorage(prepare)));
    await jest.advanceTimersByTimeAsync(11000);
    expect(await result).toEqual(['shared-contact','shared-contact','shared-contact']);expect(creations).toBe(1);
  });
  it('bounds waiting when a provisioning worker cannot finish',async()=>{
    jest.useFakeTimers();const prepare=jest.fn(async()=>{throw pending();});
    const result=waitForStudentDocumentStorage(prepare).catch(error=>error);
    await jest.advanceTimersByTimeAsync(11000);
    expect(await result).toBeInstanceOf(ConflictException);expect(prepare).toHaveBeenCalledTimes(6);
  });
  for(const error of [new BadGatewayException('Provider timeout'),new ConflictException({errorCode:'xero_rate_limited'}),new ConflictException('Case archived')])
    it('does not retry provider errors, quota refusals or authorization failures',async()=>{
      const prepare=jest.fn(async()=>{throw error;});
      await expect(waitForStudentDocumentStorage(prepare)).rejects.toBe(error);expect(prepare).toHaveBeenCalledTimes(1);
    });
});
