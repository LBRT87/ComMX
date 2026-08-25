import { IsString, IsNotEmpty } from 'class-validator';


export class LoginDTO {
  @IsNotEmpty()
  @IsString()
  username: string;
  @IsNotEmpty()
  @IsString()
  password: string;

}
