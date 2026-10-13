import "reflect-metadata";
import {
  Module,
  Controller,
  Get,
  Post,
  Body,
  Param,
  Req,
  Headers,
  Inject,
  CanActivate,
  ExecutionContext,
  Injectable,
  Catch,
  ExceptionFilter,
  ArgumentsHost,
  HttpException,
} from "@nestjs/common";
import { APP_GUARD, APP_FILTER } from "@nestjs/core";
import { Request, Response } from "express";
import { ZodError } from "zod";
import { OfframpService } from "../../../packages/core/src/service";
import { Actor, Store } from "../../../packages/core/src/types";
import { ACTORS } from "../../../packages/core/src/fixtures";
import { DomainError, demand } from "../../../packages/core/src/money";
import { MockScenarioService } from "./demo";
import { assertSafeRuntime } from "../../../packages/core/src/security";
interface DemoRequest extends Request {
  actor: Actor;
  rawBody?: Buffer;
}
@Injectable()
class DemoAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<DemoRequest>();
    if (
      request.path === "/api/health" ||
      request.path === "/api/webhooks/mock-deposit"
    )
      return true;
    const key = request.header("x-demo-actor");
    demand(
      process.env.DEMO_AUTH === "true" && process.env.NODE_ENV !== "production",
      "AUTH_REQUIRED",
      "Mock authentication is disabled",
    );
    demand(
      key && ACTORS[key],
      "UNAUTHENTICATED",
      "Select a known demo fixture actor",
    );
    request.actor = ACTORS[key];
    return true;
  }
}
@Catch()
class SafeErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (error instanceof DomainError)
      return res
        .status(
          ["FORBIDDEN", "MAKER_CHECKER", "WRONG_MAKER"].includes(error.code)
            ? 403
            : error.code === "UNAUTHENTICATED"
              ? 401
              : error.code === "NOT_FOUND"
                ? 404
                : 409,
        )
        .json({ error: error.code, message: error.message });
    if (error instanceof ZodError)
      return res.status(400).json({
        error: "INVALID_INPUT",
        issues: error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      });
    if (error instanceof HttpException)
      return res
        .status(error.getStatus())
        .json({ error: "HTTP_ERROR", message: error.message });
    if (error instanceof SyntaxError)
      return res.status(400).json({ error: "INVALID_JSON" });
    console.error(
      "Unhandled request error:",
      error instanceof Error ? error.name : "unknown",
    );
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  }
}
@Controller("api")
class OperationsController {
  constructor(
    @Inject(OfframpService) private readonly core: OfframpService,
    @Inject(MockScenarioService) private readonly demo: MockScenarioService,
  ) {}
  @Post("demo/scenario") seed(@Req() r: DemoRequest, @Body() body: unknown) {
    return this.demo.seed(r.actor, body);
  }
  @Post("demo/orders/:id/deposit") mockDeposit(
    @Req() r: DemoRequest,
    @Param("id") id: string,
  ) {
    return this.demo.deposit(r.actor, id);
  }
  @Get("health") async health() {
    const healthy = await this.core.store.health();
    return {
      status: healthy ? "ok" : "degraded",
      mode: "MOCK",
      realExecutionEnabled: false,
      persistence: process.env.STORAGE_MODE ?? "memory",
    };
  }
  @Get("dashboard") dashboard(@Req() r: DemoRequest) {
    return this.core.dashboard(r.actor);
  }
  @Get("audit") audit(@Req() r: DemoRequest) {
    return this.core.auditTrail(r.actor);
  }
  @Post("customers") customer(@Req() r: DemoRequest, @Body() b: unknown) {
    return this.core.createCustomer(r.actor, b);
  }
  @Post("customers/:id/review") review(
    @Req() r: DemoRequest,
    @Param("id") id: string,
    @Body() b: any,
  ) {
    return this.core.reviewCustomer(r.actor, id, b.status);
  }
  @Post("beneficiaries") beneficiary(
    @Req() r: DemoRequest,
    @Body() b: unknown,
  ) {
    return this.core.createBeneficiary(r.actor, b);
  }
  @Post("beneficiaries/:id/approve") approveBeneficiary(
    @Req() r: DemoRequest,
    @Param("id") id: string,
  ) {
    return this.core.approveBeneficiary(r.actor, id);
  }
  @Post("quotes") quote(@Req() r: DemoRequest, @Body() b: unknown) {
    return this.core.createQuote(r.actor, b);
  }
  @Post("orders") order(@Req() r: DemoRequest, @Body() b: unknown) {
    return this.core.createOrder(r.actor, b);
  }
  @Post("orders/:id/conversion") conversion(
    @Req() r: DemoRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.core.recordConversion(r.actor, id, b);
  }
  @Post("orders/:id/attempts") prepare(
    @Req() r: DemoRequest,
    @Param("id") id: string,
    @Body() b: any,
  ) {
    return this.core.preparePayout(r.actor, id, b.idempotencyKey);
  }
  @Post("attempts/:id/approve") approve(
    @Req() r: DemoRequest,
    @Param("id") id: string,
  ) {
    return this.core.approvePayout(r.actor, id);
  }
  @Post("attempts/:id/record") record(
    @Req() r: DemoRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.core.recordPayout(r.actor, id, b);
  }
  @Post("attempts/:id/resolve") resolve(
    @Req() r: DemoRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.core.resolvePayout(r.actor, id, b);
  }
  @Post("orders/:id/receipt-metadata") receipt(
    @Req() r: DemoRequest,
    @Param("id") id: string,
    @Body() b: any,
  ) {
    return this.core.uploadReceipt(r.actor, id, b.objectKey);
  }
  @Post("orders/:id/reconcile") reconcile(
    @Req() r: DemoRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.core.reconcile(r.actor, id, b);
  }
  @Post("discrepancies/:id/resolve") discrepancy(
    @Req() r: DemoRequest,
    @Param("id") id: string,
    @Body() b: any,
  ) {
    return this.core.resolveDiscrepancy(r.actor, id, b.evidence);
  }
  @Post("orders/:id/refunds") refund(
    @Req() r: DemoRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.core.requestRefund(r.actor, id, b);
  }
  @Post("refunds/:id/approve") approveRefund(
    @Req() r: DemoRequest,
    @Param("id") id: string,
  ) {
    return this.core.approveRefund(r.actor, id);
  }
  @Post("refunds/:id/record") recordRefund(
    @Req() r: DemoRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.core.recordRefund(r.actor, id, b);
  }
  @Post("settlements") settlement(@Req() r: DemoRequest, @Body() b: unknown) {
    return this.core.createSettlement(r.actor, b);
  }
  @Post("settlements/:id/approve") approveSettlement(
    @Req() r: DemoRequest,
    @Param("id") id: string,
  ) {
    return this.core.approveSettlement(r.actor, id);
  }
  @Post("settlements/:id/cancel") cancelSettlement(
    @Req() r: DemoRequest,
    @Param("id") id: string,
    @Body() b: any,
  ) {
    return this.core.cancelSettlement(r.actor, id, b.reason);
  }
  @Post("batches") batch(@Req() r: DemoRequest, @Body() b: any) {
    return this.core.importBatch(r.actor, b.customerId, b.clientBatchId, b.csv);
  }
  @Post("batches/:id/submit") submitBatch(
    @Req() r: DemoRequest,
    @Param("id") id: string,
  ) {
    return this.core.submitBatch(r.actor, id);
  }
  @Post("webhooks/mock-deposit") deposit(
    @Req() r: DemoRequest,
    @Headers("x-webhook-timestamp") timestamp: string,
    @Headers("x-webhook-signature") signature: string,
  ) {
    demand(r.rawBody, "RAW_BODY_REQUIRED", "Raw request body missing");
    return this.core.receiveDeposit(
      r.rawBody,
      timestamp,
      signature,
      process.env.WEBHOOK_SECRET ?? "",
    );
  }
}
export function makeAppModule(store: Store) {
  assertSafeRuntime(process.env);
  const core = new OfframpService(store);
  @Module({
    controllers: [OperationsController],
    providers: [
      { provide: OfframpService, useValue: core },
      { provide: MockScenarioService, useValue: new MockScenarioService(core) },
      { provide: APP_GUARD, useClass: DemoAuthGuard },
      { provide: APP_FILTER, useClass: SafeErrorFilter },
    ],
  })
  class AppModule {}
  return AppModule;
}
