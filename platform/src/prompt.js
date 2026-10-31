// Asks a question in the terminal without showing what is typed (for passwords).
import {createInterface} from 'node:readline';

export function askHidden(question) {
    return new Promise(resolve => {
        const rl = createInterface({input: process.stdin, output: process.stdout, terminal: true});
        rl._writeToOutput = text => rl.output.write(text.includes(question) ? text : '');
        rl.question(question, answer => {
            rl.close();
            process.stdout.write('\n');
            resolve(answer);
        });
    });
}
