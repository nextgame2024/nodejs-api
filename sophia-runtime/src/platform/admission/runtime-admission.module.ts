import { Global, Module } from "@nestjs/common";
import { RuntimeAdmissionService } from "./runtime-admission.service.js";

@Global()
@Module({ providers: [RuntimeAdmissionService], exports: [RuntimeAdmissionService] })
export class RuntimeAdmissionModule {}
