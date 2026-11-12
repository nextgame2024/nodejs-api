import { ConflictException } from '@nestjs/common';

// Wait only for another request's durable provisioning lease. Never retry a
// provider failure or a file write. Sleeps run outside database transactions.
export async function waitForStudentDocumentStorage<T>(prepare:()=>Promise<T>):Promise<T> {
  const delays=[250,750,1500,3000,5000];
  for(let attempt=0;;attempt++){
    try{return await prepare();}
    catch(error){
      const response=error instanceof ConflictException?error.getResponse():null;
      if(!response||typeof response!=='object'||!('errorCode' in response)
        ||response.errorCode!=='student_document_storage_pending'||attempt>=delays.length)throw error;
      await new Promise<void>(resolve=>setTimeout(resolve,delays[attempt]));
    }
  }
}
