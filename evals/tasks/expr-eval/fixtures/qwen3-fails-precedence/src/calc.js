export function evaluate(expression) {
    let expr = expression.replace(/\s+/g, '');
    if (expr === '') {
        throw new Error('Empty input');
    }

    const validChars = '0123456789.+-*/()';
    for (let c of expr) {
        if (!validChars.includes(c)) {
            throw new Error('Invalid character');
        }
    }

    let tokens = tokenize(expr);

    // Check for unbalanced parentheses
    let parenCount = 0;
    for (let token of tokens) {
        if (token === '(') parenCount++;
        else if (token === ')') parenCount--;
        if (parenCount < 0) {
            throw new Error('Mismatched parentheses');
        }
    }

    if (parenCount !== 0) {
        throw new Error('Mismatched parentheses');
    }

    const postfix = shuntingYard(tokens);
    let result = evaluatePostfix(postfix);
    return result;
}

function tokenize(expr) {
    const tokens = [];
    let i = 0;
    let prevTokenType = null; // 'number', 'operator', 'parenthesis'
    while (i < expr.length) {
        const c = expr[i];
        if (/\d/.test(c) || c === '.') {
            let numStr = '';
            while (i < expr.length && (/[\d.]/.test(expr[i]))) {
                numStr += expr[i];
                i++;
            }
            tokens.push(numStr);
            prevTokenType = 'number';
        } else if (c === '(' || c === ')') {
            tokens.push(c);
            prevTokenType = 'parenthesis';
            i++;
        } else if (['+', '-', '*', '/'].includes(c)) {
            let isUnary = false;
            if (c === '-') {
                // Check previous token type
                if (prevTokenType === null || prevTokenType === 'operator' || prevTokenType === 'parenthesis') {
                    isUnary = true;
                }
            }
            if (isUnary) {
                tokens.push('u-');
            } else {
                tokens.push(c);
            }
            prevTokenType = 'operator';
            i++;
        } else {
            throw new Error('Invalid character');
        }
    }
    return tokens;
}

function shuntingYard(tokens) {
    const output = [];
    const stack = [];
    for (const token of tokens) {
        if (/^-?\d+(\.\d+)?$/.test(token)) { // check if it's a number
            output.push(token);
        } else if (token === '(') {
            stack.push(token);
        } else if (token === ')') {
            while (stack.length > 0 && stack[stack.length -1] !== '(') {
                output.push(stack.pop());
            }
            if (stack.length === 0 || stack[stack.length -1] !== '(') {
                throw new Error('Mismatched parentheses');
            }
            stack.pop(); // remove '('
        } else { // operator
            const precedence = getPrecedence(token);
            while (stack.length > 0 && stack[stack.length -1] !== '(' && 
                   (getPrecedence(stack[stack.length -1]) > precedence || 
                    (getPrecedence(stack[stack.length -1]) === precedence && token !== 'u-'))) {
                output.push(stack.pop());
            }
            stack.push(token);
        }
    }

    while (stack.length > 0) {
        if (stack[stack.length -1] === '(') {
            throw new Error('Mismatched parentheses');
        }
        output.push(stack.pop());
    }

    return output;
}

function getPrecedence(token) {
    switch (token) {
        case 'u-':
            return 4;
        case '*':
        case '/':
            return 3;
        case '+':
        case '-':
            return 2;
        default:
            throw new Error('Unknown operator');
    }
}

function evaluatePostfix(postfix) {
    const stack = [];
    for (const token of postfix) {
        if (/^-?\d+(\.\d+)?$/.test(token)) { // number
            stack.push(parseFloat(token));
        } else if (token === 'u-') {
            if (stack.length < 1) {
                throw new Error('Invalid expression');
            }
            const operand = stack.pop();
            stack.push(-operand);
        } else { // binary operator
            if (stack.length < 2) {
                throw new Error('Invalid expression');
            }
            const right = stack.pop();
            const left = stack.pop();
            let result;
            switch (token) {
                case '+':
                    result = left + right;
                    break;
                case '-':
                    result = left - right;
                    break;
                case '*':
                    result = left * right;
                    break;
                case '/':
                    if (right === 0) {
                        throw new Error('Division by zero');
                    }
                    result = left / right;
                    break;
                default:
                    throw new Error('Unknown operator');
            }
            stack.push(result);
        }
    }

    if (stack.length !== 1) {
        throw new Error('Invalid expression');
    }

    return stack[0];
}