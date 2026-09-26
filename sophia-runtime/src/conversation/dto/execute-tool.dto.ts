import { IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

export class ExecuteToolDto {
  @IsString()
  toolName!: string;

  @IsObject()
  input!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  providerCallId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  providerEventId?: string;

  @IsOptional()
  @IsIn(["browser", "provider_sideband"])
  eventSource?: "browser" | "provider_sideband";

  @IsOptional()
  @IsUUID()
  correlationId?: string;
}
