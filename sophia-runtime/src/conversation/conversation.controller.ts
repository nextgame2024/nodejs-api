import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { ConversationService } from "./conversation.service.js";
import { CreateSessionDto } from "./dto/create-session.dto.js";
import { ExecuteToolDto } from "./dto/execute-tool.dto.js";

@Controller("sessions")
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
  getSession(@Param("sessionId") sessionId: string) {
    return this.conversation.getSession(sessionId);
  }

  @Post(":sessionId/tools")
  executeTool(
    @Param("sessionId") sessionId: string,
    @Body() dto: ExecuteToolDto,
  ) {
    return this.conversation.executeTool(sessionId, dto);
  }

  @Post(":sessionId/close")
  closeSession(@Param("sessionId") sessionId: string) {
    return this.conversation.closeSession(sessionId);
  }
}
