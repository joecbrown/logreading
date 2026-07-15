// lambda/index.js
//
// Alexa skill handler. Deliberately thin: it only translates intents <-> the
// ledgerStore actions, which in turn wrap the pure, tested rules in
// lib/ledger.js. No business logic should live in this file.
//
// NOTE ON STORAGE: uses DynamoDB when READING_APP_TABLE is set (the real
// deployed Lambda should always set this — see infra/table.json for the
// table definition), otherwise falls back to the in-memory store for local
// development and tests. In-memory state does NOT persist across Lambda
// cold starts or concurrent invocations, so READING_APP_TABLE must be set
// in the real deployment's Lambda configuration.

const Alexa = require('ask-sdk-core');
const { createMemoryStore } = require('../lib/store');
const { createDynamoStore } = require('../lib/dynamoStore');
const { makeLedgerActions } = require('../lib/ledgerStore');

const store = process.env.READING_APP_TABLE ? createDynamoStore() : createMemoryStore();
const ledgerActions = makeLedgerActions(store);

function getChildName(handlerInput) {
  const raw = Alexa.getSlotValue(handlerInput.requestEnvelope, 'ChildName');
  if (!raw) return null;
  // Normalize casing so "Emma" and "emma" hit the same ledger entry.
  return raw.trim().toLowerCase();
}

// Hours are always multiples of 0.5 in real use (30-min reading increments),
// but floating-point math plus near-zero durations (e.g. in tests) can
// produce values like 5.5e-7. Round before anything reaches spoken output —
// Alexa's TTS will otherwise read out the raw number, decimals and all.
function roundHours(n) {
  return Math.round(n * 100) / 100;
}

const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
  },
  handle(handlerInput) {
    const speakOutput =
      'Welcome to Reading Time. You can say, start reading for Emma, or, ' +
      'check Emma\'s balance.';
    return handlerInput.responseBuilder
      .speak(speakOutput)
      .reprompt(speakOutput)
      .getResponse();
  },
};

const StartReadingIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === 'StartReadingIntent'
    );
  },
  async handle(handlerInput) {
    const childName = getChildName(handlerInput);
    if (!childName) {
      return handlerInput.responseBuilder
        .speak("Who's starting to read?")
        .reprompt("Who's starting to read?")
        .getResponse();
    }
    try {
      await ledgerActions.startReading(childName, new Date().toISOString());
      return handlerInput.responseBuilder
        .speak(`Okay, starting the reading timer for ${childName}.`)
        .getResponse();
    } catch (err) {
      if (err.code === 'SESSION_ALREADY_ACTIVE') {
        return handlerInput.responseBuilder
          .speak(`${childName} already has a reading session going.`)
          .getResponse();
      }
      throw err;
    }
  },
};

const StopReadingIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === 'StopReadingIntent'
    );
  },
  async handle(handlerInput) {
    const childName = getChildName(handlerInput);
    if (!childName) {
      return handlerInput.responseBuilder
        .speak('Who just finished reading?')
        .reprompt('Who just finished reading?')
        .getResponse();
    }
    try {
      const result = await ledgerActions.stopReading(childName, new Date().toISOString());
      const minutesRead = result.minutesRead;
      const hoursEarned = roundHours(result.hoursEarned);
      const speakOutput =
        hoursEarned > 0
          ? `Nice work — ${childName} read for ${minutesRead} minutes and earned ` +
            `${hoursEarned} bonus hour${hoursEarned === 1 ? '' : 's'} this week.`
          : `${childName} read for ${minutesRead} minutes. That's under 30 minutes, ` +
            'so no bonus hour yet — every 30 minutes earns one.';
      return handlerInput.responseBuilder.speak(speakOutput).getResponse();
    } catch (err) {
      if (err.code === 'NO_ACTIVE_SESSION') {
        return handlerInput.responseBuilder
          .speak(`I don't have a reading session in progress for ${childName}.`)
          .getResponse();
      }
      throw err;
    }
  },
};

const CheckBalanceIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === 'CheckBalanceIntent'
    );
  },
  async handle(handlerInput) {
    const childName = getChildName(handlerInput);
    if (!childName) {
      return handlerInput.responseBuilder
        .speak('Whose balance do you want to check?')
        .reprompt('Whose balance do you want to check?')
        .getResponse();
    }
    const balance = await ledgerActions.getBalance(childName, new Date().toISOString());
    const bonusHoursRemaining = roundHours(balance.bonusHoursRemaining);
    const availableToday = roundHours(balance.availableToday);
    const speakOutput =
      `${childName} has ${bonusHoursRemaining} bonus hour${bonusHoursRemaining === 1 ? '' : 's'} ` +
      `left this week, for a total of ${availableToday} hour${availableToday === 1 ? '' : 's'} available today.`;
    return handlerInput.responseBuilder.speak(speakOutput).getResponse();
  },
};

const HelpIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent'
    );
  },
  handle(handlerInput) {
    const speakOutput =
      'You can say, start reading for Emma, stop reading for Emma, or, ' +
      "check Emma's balance.";
    return handlerInput.responseBuilder.speak(speakOutput).reprompt(speakOutput).getResponse();
  },
};

const CancelAndStopIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      (Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.CancelIntent' ||
        Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.StopIntent')
    );
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder.speak('Goodbye!').getResponse();
  },
};

const SessionEndedRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder.getResponse();
  },
};

const ErrorHandler = {
  canHandle() {
    return true;
  },
  handle(handlerInput, error) {
    console.error(error);
    return handlerInput.responseBuilder
      .speak("Sorry, I had trouble doing that. Please try again.")
      .reprompt("Sorry, I had trouble doing that. Please try again.")
      .getResponse();
  },
};

const skillBuilder = Alexa.SkillBuilders.custom().addRequestHandlers(
  LaunchRequestHandler,
  StartReadingIntentHandler,
  StopReadingIntentHandler,
  CheckBalanceIntentHandler,
  HelpIntentHandler,
  CancelAndStopIntentHandler,
  SessionEndedRequestHandler
).addErrorHandlers(ErrorHandler);

exports.handler = skillBuilder.lambda();
// Exported separately so tests can invoke the skill without going through
// the Lambda entrypoint wrapper.
exports.skill = skillBuilder.create();
