import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, GetPublicAccessBlockCommand, GetBucketLifecycleConfigurationCommand, GetBucketVersioningCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const prefix='student-document-analysis/';
const limit=10*1024*1024;
/** Private, optional optimization. Lifecycle expiry also collects abandoned uploads. */
export class StudentDocumentTempStorage {
  private client?:S3Client;
  private ready?:Promise<void>;
  get enabled(){return process.env.STUDENT_DOCUMENT_TEMP_STORAGE_ENABLED==='true';}
  private get bucket(){return process.env.STUDENT_DOCUMENT_TEMP_S3_BUCKET;}
  private storage(){
    const region=process.env.STUDENT_DOCUMENT_TEMP_S3_REGION;
    if(!this.enabled||!this.bucket||!region)throw new Error('document_temp_storage_not_configured');
    return this.client??=new S3Client({region,maxAttempts:2});
  }
  key(tenant:string,caseId:string,operationId:string,hash:string){
    if(![tenant,caseId,operationId].every(v=>/^[a-f0-9-]{36}$/i.test(v))||!/^[a-f0-9]{64}$/.test(hash))throw new Error('invalid_document_temp_scope');
    return `${prefix}${tenant}/${caseId}/${operationId}/${hash}`;
  }
  private async readiness(){
    if(!this.ready)this.ready=(async()=>{
      const client=this.storage(),Bucket=this.bucket;
      const block=(await client.send(new GetPublicAccessBlockCommand({Bucket}),{abortSignal:AbortSignal.timeout(5000)})).PublicAccessBlockConfiguration;
      if(!block?.BlockPublicAcls||!block.IgnorePublicAcls||!block.BlockPublicPolicy||!block.RestrictPublicBuckets)throw new Error('document_temp_storage_not_private');
      const versioning=await client.send(new GetBucketVersioningCommand({Bucket}),{abortSignal:AbortSignal.timeout(5000)});
      if(versioning.Status)throw new Error('document_temp_storage_must_be_unversioned');
      const lifecycle=await client.send(new GetBucketLifecycleConfigurationCommand({Bucket}),{abortSignal:AbortSignal.timeout(5000)});
      if(!lifecycle.Rules?.some(r=>r.Status==='Enabled'&&r.Expiration?.Days===1&&
        (r.Filter?.Prefix===prefix||r.Prefix===prefix)))throw new Error('document_temp_storage_expiry_required');
    })().catch(error=>{this.ready=undefined;throw error;});
    await this.ready;
  }
  async put(key:string,bytes:Buffer,mime:string):Promise<void>{
    if(!bytes.length||bytes.length>limit)throw new Error('document_temp_size_invalid');
    await this.readiness();
    await this.storage().send(new PutObjectCommand({Bucket:this.bucket,Key:key,Body:bytes,ContentType:mime,
      ContentLength:bytes.length,ChecksumSHA256:createHash('sha256').update(bytes).digest('base64'),ServerSideEncryption:'AES256'}),
      {abortSignal:AbortSignal.timeout(10000)});
  }
  async read(key:string):Promise<Buffer>{
    const result=await this.storage().send(new GetObjectCommand({Bucket:this.bucket,Key:key,Range:`bytes=0-${limit}`}),{abortSignal:AbortSignal.timeout(10000)});
    if(!result.LastModified||Date.now()-result.LastModified.getTime()>86400000){
      if(result.Body instanceof Readable)result.Body.destroy();
      throw new Error('document_temp_expired');
    }
    const bytes=await result.Body?.transformToByteArray();
    if(!bytes?.length||bytes.length>limit)throw new Error('document_temp_size_invalid');
    return Buffer.from(bytes);
  }
  async remove(key:string){
    await this.storage().send(new DeleteObjectCommand({Bucket:this.bucket,Key:key}),{abortSignal:AbortSignal.timeout(5000)});
  }
}
export const studentDocumentTempStorage=new StudentDocumentTempStorage();
