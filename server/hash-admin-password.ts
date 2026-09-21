import { Secret } from 'cliffy/prompt/secret';
import { hash } from 'argon2ian';
import { encodeBase64Url } from '@std/encoding/base64url';

const password = await Secret.prompt('New admin password');
const salt = crypto.getRandomValues(new Uint8Array(32));
console.log('ADMIN_PASSWORD_HASH=' + encodeBase64Url(hash(new TextEncoder().encode(password), salt)));
console.log('ADMIN_PASSWORD_SALT=' + encodeBase64Url(salt));
