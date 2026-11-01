import { Layer, type Option } from "effect";
import { RpcServer } from "effect/rpc";
import { ownPagesOnly } from "./own-pages.ts";

/**
The page's RPC socket at `/rpc`. An upgrade from a page that is not on this machine or at `publicHost` is
refused with 403 before any RPC.
*/
export const rpcSocket = (publicHost: Option.Option<string>) =>
  RpcServer.layerProtocolWebsocket({ path: "/rpc" }).pipe(
    Layer.provide(ownPagesOnly(publicHost).layer),
  );
