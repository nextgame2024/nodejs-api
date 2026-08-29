import { IsOptional, IsString, IsUUID } from "class-validator";

export class CreateSessionDto {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsUUID()
  deviceId?: string;

  @IsOptional()
  @IsString()
  storeId?: string;

  @IsOptional()
  @IsString()
  createdByUserId?: string;
}
