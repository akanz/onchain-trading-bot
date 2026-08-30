import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";

@Injectable()
export class WebApiGuard implements CanActivate {
  canActivate(context:ExecutionContext):boolean {
    const expected=process.env.WEB_API_TOKEN,provided=String(context.switchToHttp().getRequest().headers.authorization??"");
    if(!expected)throw new UnauthorizedException("WEB_API_TOKEN is not configured");
    const wanted=Buffer.from(`Bearer ${expected}`),actual=Buffer.from(provided);
    if(wanted.length!==actual.length||!timingSafeEqual(wanted,actual))throw new UnauthorizedException();
    return true;
  }
}
