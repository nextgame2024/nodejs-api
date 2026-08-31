import { IsIn, IsOptional, IsString, IsUUID } from "class-validator";
import type { AvatarProviderSelection } from "../../providers/avatar/avatar-provider.interface.js";
import type { AvatarSessionMode } from "../../providers/avatar/avatar-provider.interface.js";

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

  @IsOptional()
  @IsIn(["none", "simli", "liveavatar"])
  avatarProvider?: AvatarProviderSelection;

  @IsOptional()
  @IsIn(["LITE", "FULL"])
  avatarMode?: AvatarSessionMode;
}
