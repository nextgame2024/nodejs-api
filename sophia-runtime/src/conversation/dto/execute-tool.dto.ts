import { IsObject, IsString } from "class-validator";

export class ExecuteToolDto {
  @IsString()
  toolName!: string;

  @IsObject()
  input!: Record<string, unknown>;
}
