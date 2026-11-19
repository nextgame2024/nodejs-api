import {test,expect} from '@jest/globals';
import {requestedLanguage,bookingName} from '../src/services/messaging/customer-preferences.js';
test('explicit language changes survive numeric booking replies without guessing from topic',()=>{
 for(const text of ['Quiero hablar en español','Can we speak Spanish?','español']) expect(requestedLanguage(text)).toBe('es');
 expect(requestedLanguage('Please continue in English')).toBe('en');
 expect(requestedLanguage('Prefiro falar português')).toBe('pt');
 for(const text of ['2','CONFIRM 123456','What services do you offer?','Do you offer Spanish translation?','not in Spanish'])expect(requestedLanguage(text)).toBeNull();
});
test('booking name is explicit, bounded and supports international names',()=>{
 expect(bookingName('NOMBRE José Muñoz')).toBe('José Muñoz');
 expect(bookingName("NAME Anne-Marie O’Neill")).toBe("Anne-Marie O’Neill");
 for(const text of ['2','CONFIRM 123456','I want to cancel','NAME <script>','NAME '+ 'a'.repeat(161)])expect(bookingName(text)).toBeNull();
});
