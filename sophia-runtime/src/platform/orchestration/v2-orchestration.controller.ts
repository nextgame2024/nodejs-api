import { Body, Controller, Get, Headers, Inject, Param, Post } from "@nestjs/common";
import { ExecuteToolDto } from "../../conversation/dto/execute-tool.dto.js";
import { V2BootstrapService } from "./v2-bootstrap.service.js";
import { V2ReadinessService } from "./v2-readiness.service.js";
import { V2SessionService } from "./v2-session.service.js";

@Controller("runtime/v2")
export class V2OrchestrationController {
  constructor(
    @Inject(V2BootstrapService) private readonly bootstrapService: V2BootstrapService,
    @Inject(V2SessionService) private readonly sessions: V2SessionService,
    @Inject(V2ReadinessService) private readonly readinessService: V2ReadinessService,
  ) {}

  @Get("readiness") readiness() { return this.readinessService.check(); }
  @Post("bootstrap") bootstrap(@Body() body: unknown, @Headers("x-sophia-installation-key") key?: string) {
    return this.bootstrapService.issue(body, key);
  }
  @Post("sessions") create(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    return this.sessions.create(body, bearer(authorization));
  }
  @Get("sessions/:sessionId") get(@Param("sessionId") id: string, @Headers("authorization") authorization?: string) {
    return this.sessions.get(id, bearer(authorization));
  }
  @Post("sessions/:sessionId/tools") tool(@Param("sessionId") id: string, @Body() dto: ExecuteToolDto, @Headers("authorization") authorization?: string) {
    return this.sessions.executeTool(id, dto, bearer(authorization));
  }
  @Post("sessions/:sessionId/action-reviews/:reviewId/confirm") review(@Param("sessionId") id: string, @Param("reviewId") reviewId: string, @Headers("authorization") authorization?: string) {
    return this.sessions.confirmReview(id, reviewId, bearer(authorization));
  }
  @Post("sessions/:sessionId/close") close(@Param("sessionId") id: string, @Headers("authorization") authorization?: string) { return this.sessions.close(id, bearer(authorization)); }
  @Post("sessions/:sessionId/heartbeat") heartbeat(@Param("sessionId") id: string, @Headers("authorization") authorization?: string) { return this.sessions.heartbeat(id, bearer(authorization)); }
  @Post("sessions/:sessionId/disconnect") disconnect(@Param("sessionId") id: string, @Headers("authorization") authorization?: string) { return this.sessions.disconnect(id, bearer(authorization)); }
}

function bearer(value?: string): string | undefined { return value?.match(/^\s*Bearer\s+([^\s]+)\s*$/i)?.[1]; }
