import { SNSHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const ddbDocClient = createDDbDocClient();

export const handler: SNSHandler = async (event: any) => {
  for (const record of event.Records) {  
    const snsMessage = JSON.parse(record.Sns.Message);

    if (snsMessage) {
      console.log("message body ", JSON.stringify(snsMessage));
      var imageName = snsMessage.name
      const imageDesc =  snsMessage.description
      if (!imageName || !imageDesc){
        throw new Error('"Name" or "description" is needed');
      }
      const commandOutput = await ddbDocClient.send(
        new UpdateCommand({
            TableName: process.env.TABLE_NAME,
            Key:{
                "imageName": imageName
            },
            UpdateExpression: 'SET description = :d',
            ExpressionAttributeValues:{
                ':d': imageDesc
            }
        })
      )

      console.log("DynamoDB Updated: ", commandOutput)

    }
  }
}

function createDDbDocClient() {
  const ddbClient = new DynamoDBClient({ region: process.env.REGION });
  const marshallOptions = {
    convertEmptyValues: true,
    removeUndefinedValues: true,
    convertClassInstanceToMap: true,
  };
  const unmarshallOptions = {
    wrapNumbers: false,
  };
  const translateConfig = { marshallOptions, unmarshallOptions };
  return DynamoDBDocumentClient.from(ddbClient, translateConfig);
}