import { IsOptional, IsUUID } from "class-validator";

export class SessionActivityDto {
  @IsUUID("4")
  connectionId!: string;
}

export class OptionalSessionActivityDto {
  @IsOptional()
  @IsUUID("4")
  connectionId?: string;
}
