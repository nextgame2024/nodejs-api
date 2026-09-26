import { Body, Controller, Delete, Get, Headers, Inject, Param, Post } from "@nestjs/common";
import { ConversationService } from "./conversation.service.js";
import { CreateSessionDto } from "./dto/create-session.dto.js";
import { ExecuteToolDto } from "./dto/execute-tool.dto.js";

@Controller("runtime/sessions")
export class ConversationController {
  constructor(
    @Inject(ConversationService)
    private readonly conversation: ConversationService,
  ) {}

  @Post()
  createSession(@Body() dto: CreateSessionDto) {
    return this.conversation.createSession(dto);
  }

  @Get(":sessionId")
  getSession(
    @Param("sessionId") sessionId: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.conversation.getSession(sessionId, bearerToken(authorization));
  }

  @Post(":sessionId/tools")
  executeTool(
    @Param("sessionId") sessionId: string,
    @Body() dto: ExecuteToolDto,
    @Headers("authorization") authorization?: string,
  ) {
    return this.conversation.executeTool(sessionId, dto, bearerToken(authorization));
  }

  @Post(":sessionId/close")
  closeSession(
    @Param("sessionId") sessionId: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.conversation.closeSession(sessionId, bearerToken(authorization));
  }

  @Post(":sessionId/heartbeat")
  heartbeatSession(
    @Param("sessionId") sessionId: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.conversation.heartbeatSession(sessionId, bearerToken(authorization));
  }

  @Post(":sessionId/disconnect")
  disconnectSession(
    @Param("sessionId") sessionId: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.conversation.disconnectSession(sessionId, bearerToken(authorization));
  }

  @Post(":sessionId/action-reviews/:reviewId/confirm")
  confirmActionReview(
    @Param("sessionId") sessionId: string,
    @Param("reviewId") reviewId: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.conversation.confirmActionReview(
      sessionId,
      reviewId,
      bearerToken(authorization),
    );
  }

  @Get(":sessionId/action-reviews/current")
  getCurrentActionReview(
    @Param("sessionId") sessionId: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.conversation.getCurrentActionReview(sessionId, bearerToken(authorization));
  }

  @Delete(":sessionId/action-reviews/:reviewId")
  cancelActionReview(
    @Param("sessionId") sessionId: string,
    @Param("reviewId") reviewId: string,
    @Headers("authorization") authorization?: string,
  ) {
    return this.conversation.cancelActionReview(sessionId, reviewId, bearerToken(authorization));
  }
}

function bearerToken(authorization?: string): string | undefined {
  return authorization?.match(/^\s*Bearer\s+([^\s]+)\s*$/i)?.[1];
}
