// Client-side guards for values that the backend validates strictly. They keep
// malformed UUIDs and empty identifiers from reaching the API as 400 responses.
export function isUuid(value:string){
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

export function isReason(value:string){
  return value.trim().length>=3;
}
