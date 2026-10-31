import { jest } from '@jest/globals';
import { S3Client,PutObjectCommand,GetPublicAccessBlockCommand,GetBucketLifecycleConfigurationCommand,GetBucketVersioningCommand,GetObjectCommand } from '@aws-sdk/client-s3';
import { StudentDocumentTempStorage } from './student-document-temp-storage.js';

describe('Private document validation cache',()=>{
  const env={...process.env};
  beforeEach(()=>{process.env.STUDENT_DOCUMENT_TEMP_STORAGE_ENABLED='true';process.env.STUDENT_DOCUMENT_TEMP_S3_BUCKET='test-private';process.env.STUDENT_DOCUMENT_TEMP_S3_REGION='ap-southeast-2';});
  afterEach(()=>{process.env={...env};jest.restoreAllMocks();});
  function mockStorage(privateBucket=true,expires=true,versioned=false){
    return jest.spyOn(S3Client.prototype,'send').mockImplementation((async(command:any)=>{
      if(command instanceof GetPublicAccessBlockCommand)return {PublicAccessBlockConfiguration:{BlockPublicAcls:privateBucket,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true}};
      if(command instanceof GetBucketLifecycleConfigurationCommand)return {Rules:expires?[{Status:'Enabled',Filter:{Prefix:'student-document-analysis/'},Expiration:{Days:1}}]:[]};
      if(command instanceof GetBucketVersioningCommand)return versioned?{Status:'Enabled'}:{};
      if(command instanceof GetObjectCommand)return {LastModified:new Date(),Body:{transformToByteArray:async()=>Buffer.from('file')}};
      return {};
    }) as never);
  }
  test.each([[false,true],[true,false]])('refuses writes without privacy and lifecycle expiry (%s,%s)',async(p,e)=>{
    const send=mockStorage(p,e),cache=new StudentDocumentTempStorage();
    await expect(cache.put('key',Buffer.from('file'),'application/pdf')).rejects.toThrow();
    expect(send.mock.calls.some(([command])=>command instanceof PutObjectCommand)).toBe(false);
  });
  test('encrypts and checksums writes; verifies the bucket only once per instance',async()=>{
    const send=mockStorage(),cache=new StudentDocumentTempStorage();
    await cache.put('key',Buffer.from('file'),'application/pdf');await cache.put('key2',Buffer.from('file'),'application/pdf');
    const writes=send.mock.calls.map(([command])=>command).filter(command=>command instanceof PutObjectCommand);
    expect(writes).toHaveLength(2);expect(writes[0].input).toMatchObject({ServerSideEncryption:'AES256',ContentLength:4,ChecksumSHA256:expect.any(String)});
    expect(send.mock.calls.filter(([command])=>command instanceof GetPublicAccessBlockCommand)).toHaveLength(1);
    expect(await cache.read('key')).toEqual(Buffer.from('file'));
    expect(cache.key('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','a'.repeat(64))).toContain('/11111111-1111-4111-8111-111111111111/');
    expect(()=>cache.key('../escape','case','op','hash')).toThrow();
  });
  test('refuses versioned buckets so deleted originals do not remain as hidden versions',async()=>{
    const send=mockStorage(true,true,true),cache=new StudentDocumentTempStorage();
    await expect(cache.put('key',Buffer.from('file'),'application/pdf')).rejects.toThrow('unversioned');
    expect(send.mock.calls.some(([command])=>command instanceof PutObjectCommand)).toBe(false);
  });
});
