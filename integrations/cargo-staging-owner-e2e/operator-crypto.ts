function ciphertext(raw:string){
 if(!/^\\x[0-9a-f]+$/i.test(raw))throw Error("INVALID_ENCRYPTION");
 const h=raw.slice(2);
 if(h.length%2||h.length<58||h.length>30000)throw Error("INVALID_ENCRYPTION");
 return Uint8Array.from({length:h.length/2},(_,i)=>parseInt(h.slice(i*2,i*2+2),16));
}
async function decrypt(key:CryptoKey,source:string){
 const bytes=ciphertext(source);
 if(bytes[0]!==1)throw Error("UNSUPPORTED_ENCRYPTION");
 const plaintext=await crypto.subtle.decrypt({name:"AES-GCM",iv:bytes.slice(1,13)},
  key,bytes.slice(13));
 const data=JSON.parse(new TextDecoder().decode(plaintext));
 if(!data||typeof data!=="object"||typeof data.email!=="string")throw Error("INVALID_PAYLOAD");
 return data;
}

export {decrypt};
