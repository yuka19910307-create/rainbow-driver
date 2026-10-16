// Review-only preparation. No request/headers, environment reads, network or storage.
// A match is NOT authorization: the client IP source has not been integrated/verified.
// This policy is for an additional operator/owner-test gate, not public rate limits.
export const DISABLED_OPERATOR_IP_POLICY=Object.freeze({
 enabled:false,addresses:Object.freeze([] as string[])
});

type MatchCode="IP_POLICY_UNCONFIGURED"|"IP_POLICY_DISABLED"|"IP_POLICY_INVALID"|
 "IP_ADDRESS_INVALID"|"IP_ADDRESS_NO_MATCH"|"IP_ADDRESS_MATCH";
type MatchResult={
 code:MatchCode,match:boolean,source_verified:false,enforcement_ready:false
};
const result=(code:MatchCode,match=false):MatchResult=>({
 code,match,source_verified:false,enforcement_ready:false
});

function ipv4(source:string):number[]|null{
 const parts=source.split(".");
 if(parts.length!==4||parts.some(part=>!(/^(0|[1-9][0-9]{0,2})$/.test(part))))return null;
 const bytes=parts.map(Number);
 return bytes.every(value=>value<=255)?bytes:null;
}

// Strict single literals only: no DNS, ports, brackets, zone ids, CIDR, lists,
// whitespace or IPv4 decimal/octal/hex shorthand. Mapped IPv6 has the IPv4 identity.
function addressBytes(input:unknown):number[]|null{
 if(typeof input!=="string"||input.length<2||input.length>45)return null;
 if(!input.includes(":"))return ipv4(input);
 if(!/^[0-9a-fA-F:.]+$/.test(input))return null;
 let source=input.toLowerCase();
 if(source.includes(".")){
  const colon=source.lastIndexOf(":"),tail=ipv4(source.slice(colon+1));
  if(!tail)return null;
  source=source.slice(0,colon+1)+((tail[0]<<8)|tail[1]).toString(16)+":"+
   ((tail[2]<<8)|tail[3]).toString(16);
 }
 const halves=source.split("::");
 if(halves.length>2)return null;
 const left=halves[0]===""?[]:halves[0].split(":");
 const right=halves.length===2&&halves[1]!==""?halves[1].split(":"):[];
 if([...left,...right].some(word=>!(/^[0-9a-f]{1,4}$/.test(word))))return null;
 const used=left.length+right.length;
 if(halves.length===1?used!==8:used>=8)return null;
 const words=[...left,...Array(8-used).fill("0"),...right];
 const bytes=words.flatMap(word=>{
  const value=parseInt(word,16);return [value>>>8,value&255];
 });
 if(bytes.slice(0,10).every(byte=>byte===0)&&bytes[10]===255&&bytes[11]===255)
  return bytes.slice(12);
 return bytes;
}

function equalAddress(left:number[],right:number[]){
 return left.length===right.length&&left.every((byte,index)=>byte===right[index]);
}

/**
 * Compare a separately resolved address to a reviewed exact-address list.
 * Never pass a client-supplied header as proof of source. An adapter must first
 * establish provenance from documented, verified ingress/runtime guarantees.
 * Fixed diagnostic codes only; input addresses must not be logged or returned.
 * Disabled/missing/invalid policy never matches. The default never enables a gate.
 */
export function matchOperatorIpPolicy(policy:unknown,candidate:unknown):MatchResult{
 if(policy===undefined||policy===null)return result("IP_POLICY_UNCONFIGURED");
 try{
  if(typeof policy!=="object"||Array.isArray(policy))return result("IP_POLICY_INVALID");
  const config=policy as Record<string,unknown>;
  if(Object.keys(config).sort().join(",")!=="addresses,enabled"||
     typeof config.enabled!=="boolean"||!Array.isArray(config.addresses)||
     config.addresses.length>64)return result("IP_POLICY_INVALID");
  if(!config.enabled)return result("IP_POLICY_DISABLED");
  if(config.addresses.length===0)return result("IP_POLICY_INVALID");
  const addresses:number[][]=[];
  for(const entry of config.addresses){
   const parsed=addressBytes(entry);
   if(!parsed||addresses.some(previous=>equalAddress(previous,parsed)))
    return result("IP_POLICY_INVALID");
   addresses.push(parsed);
  }
  const parsed=addressBytes(candidate);
  if(!parsed)return result("IP_ADDRESS_INVALID");
  return addresses.some(address=>equalAddress(address,parsed))
   ?result("IP_ADDRESS_MATCH",true):result("IP_ADDRESS_NO_MATCH");
 }catch{return result("IP_POLICY_INVALID")}
}
